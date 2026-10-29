import "server-only";
import { requireUser } from "@/lib/auth/guards";
import {
  cidSchema,
  conversationStateSchema,
  sendMessageSchema,
  type ConversationResponse,
  type ConversationsPage,
  type MessagesPage,
  type SendMessageResponse,
  type StartConversationResponse,
  type UnreadResponse,
} from "@/lib/contracts/messaging";
import { rentalRequestProblem } from "@/lib/contracts/rental-requests";
import { offerProblem, startConversationOfferSchema } from "@/lib/contracts/offers";
import { getListing } from "@/lib/db/repositories/listings";
import { serverEnv } from "@/lib/env";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json, noContent } from "@/lib/http/route";
import { assertQuotas } from "@/lib/quota/gate";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { assertLimit, consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { moroccoToday } from "@/lib/listings/rental-availability";
import { actOnRentalRequest, rentalListingUnit, requestAction } from "@/lib/rental-requests/service";
import { assertOfferListing } from "@/lib/offers/listing";
import { actOnOffer, makeAction } from "@/lib/offers/service";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { conversationId } from "./ids";
import { screenPlace } from "./place";
import { MESSAGING_READ_QUOTAS, conversationRow, inboxPage, threadPage, type Charged } from "./reads";
import { MESSAGING_QUOTAS, changeConversationState, readConversation, sendMessage, startConversation, unreadBadge, type MessagingActor } from "./service";
import { markSeen } from "./unread";
import { enforceSendLimits } from "./send-limits";
import { decodeCursor, type CursorKind } from "./views";

// Route handlers of /api/conversations/** and /api/messages/unread (design D2-D9, §4). Members
// only (staff accounts never message, D8), the session's revocation checked on every route (D2):
// Origin + CSRF on every POST. Writing (start, send) refuses a suspended account (403
// account_suspended); the GET routes, the read receipt, archive, delete for me and block stay open
// to it (D9: a suspended user still reads his conversations). Writes: guard, body, the send
// limiters, quota gate, Turnstile, then the first Firestore read. Reads: guard, parameters, the
// call and document limiters, the read quota gate, then Firestore. No phone check anywhere:
// messaging is the only channel between buyer and seller.

type Params = Promise<Record<string, string | string[] | undefined>>;

/** Large enough for a 2 000-character message in Arabic (UTF-8, JSON escapes) and a Turnstile token. */
export const MESSAGE_BODY_MAX = 32 * 1024;

async function cidOf(params: Params): Promise<string> {
  const { cid } = await params;
  const parsed = cidSchema.safeParse(cid);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

const actorOf = (auth: Awaited<ReturnType<typeof requireUser>>): MessagingActor => ({ uid: auth.user.uid, claims: auth.user.claims });

/** `name` of the query string as a cursor of `kind`; 400 for anything this server did not produce. */
function cursorParam(url: URL, name: string, kind: CursorKind) {
  const value = url.searchParams.get(name);
  if (!value) return undefined;
  const cursor = decodeCursor(value, kind);
  if (!cursor) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: name, code: "invalid_value" }] });
  return cursor;
}

/**
 * A read of the caller's conversations (D2): the call limiter, then the document budget (one point
 * before the read, so a spent budget reads nothing; the rest after) and the read quota gate.
 */
async function chargedRead<T>(uid: string, read: () => Promise<Charged<T>>): Promise<T> {
  await enforceLimit("conversation.read.uid", uid);
  await enforceLimit("conversation.docs.uid", uid);
  await assertQuotas(MESSAGING_READ_QUOTAS);
  const { body, reads } = await read();
  if (reads > 1) await consumeLimit("conversation.docs.uid", uid, reads - 1);
  return body;
}

const readGuard = (request: Request) => requireUser(request, { checkRevoked: true, allowSuspended: true });

/** GET /api/conversations?cursor=&archived=1 -> ConversationsPage; marks the account active (digest). */
export async function handleInbox(request: Request): Promise<Response> {
  const auth = await readGuard(request);
  const url = new URL(request.url);
  const cursor = cursorParam(url, "cursor", "conversation");
  const archived = ["1", "true"].includes(url.searchParams.get("archived") ?? "");
  const body: ConversationsPage = await chargedRead(auth.user.uid, () => inboxPage(auth.user.uid, { cursor, archived }));
  await markSeen(auth.user.uid);
  return json(body);
}

/** GET /api/conversations/{cid} -> ConversationResponse (404 unless visible to the caller). */
export async function handleConversation(request: Request, params: Params): Promise<Response> {
  const auth = await readGuard(request);
  const cid = await cidOf(params);
  const body: ConversationResponse = await chargedRead(auth.user.uid, () => conversationRow(auth.user.uid, cid));
  return json(body);
}

/** GET /api/conversations/{cid}/messages?cursor= | ?after= -> MessagesPage (404 unless visible). */
export async function handleThread(request: Request, params: Params): Promise<Response> {
  const auth = await readGuard(request);
  const cid = await cidOf(params);
  const url = new URL(request.url);
  const before = cursorParam(url, "cursor", "message");
  const after = cursorParam(url, "after", "message");
  if (before && after) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "after", code: "invalid_value" }] });
  const body: MessagesPage = await chargedRead(auth.user.uid, () => threadPage(auth.user.uid, cid, { before, after }));
  await markSeen(auth.user.uid);
  return json(body);
}

/**
 * POST /api/conversations {listingId, text, turnstileToken, adultConfirmed?, rentalRequest?, offer?}
 * -> 201 StartConversationResponse. With a booking request (rental pack §6; a holiday home's stay): its dates
 * are checked and the request limiter consumed before Turnstile, the listing read after it, then
 * the message and the request's system step. With a price offer (Carte vivante lot 5): the offer
 * limiters before Turnstile, the listing read and the amount checked against its price after it,
 * then the message (the offer's note) and the offer's system step.
 */
export async function handleStart(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true });
  const input = await readJson(request, startConversationOfferSchema, MESSAGE_BODY_MAX);
  const now = new Date();
  const rental = input.rentalRequest;
  const offer = input.offer;
  if (rental) {
    const problem = rentalRequestProblem(rental, moroccoToday(now));
    if (problem) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "rentalRequest.from", code: problem }] });
    // Refused before the message is sent: the conversation never starts half way (A-02).
    if (rental.pickup) screenPlace(rental.pickup);
    assertLimit("rental.request.uid", await consumeLimit("rental.request.uid", auth.user.uid));
  }
  if (offer) {
    assertLimit("offer.uid", await consumeLimit("offer.uid", auth.user.uid));
    assertLimit("offer.thread", await consumeLimit("offer.thread", `${auth.user.uid}:${conversationId(input.listingId, auth.user.uid)}`));
  }
  await enforceSendLimits(auth.user.uid, conversationId(input.listingId, auth.user.uid));
  await assertQuotas(MESSAGING_QUOTAS);
  // Turnstile on every first message (AF §6), before any read: the token is single use.
  const identity = requestIdentity(request.headers);
  const check = await verifyTurnstile(input.turnstileToken, { action: "message", remoteIp: identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!check.ok) throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: check.codes } });
  const listing = rental || offer ? await getListing(input.listingId) : null;
  if (rental) {
    // A stay's nights, checked before the conversation starts.
    const problem = rentalRequestProblem(rental, moroccoToday(now), rentalListingUnit(listing));
    if (problem) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "rentalRequest.from", code: problem }] });
  }
  let offerPrice: number | undefined;
  if (offer) {
    offerPrice = assertOfferListing(listing, now);
    const problem = offerProblem(offer.amount, offerPrice);
    if (problem) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "offer.amount", code: problem }] });
  }
  const actor = actorOf(auth);
  const body: StartConversationResponse = await startConversation(actor, { listingId: input.listingId, text: input.text, adultConfirmed: input.adultConfirmed === true }, now);
  // One millisecond later: the request's step reads after the message in the thread.
  if (rental && listing) await actOnRentalRequest(actor, body.cid, requestAction(rental), new Date(now.getTime() + 1), listing);
  if (offer && offerPrice !== undefined) await actOnOffer(actor, body.cid, makeAction(offer), new Date(now.getTime() + 1), offerPrice);
  return json(body, { status: 201 });
}

/** POST /api/conversations/{cid}/messages {text} -> 201 SendMessageResponse. */
export async function handleSend(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true });
  const cid = await cidOf(params);
  const input = await readJson(request, sendMessageSchema, MESSAGE_BODY_MAX);
  await enforceSendLimits(auth.user.uid, cid);
  await assertQuotas(MESSAGING_QUOTAS);
  const body: SendMessageResponse = await sendMessage(actorOf(auth), cid, input.text);
  return json(body, { status: 201 });
}

/** POST /api/conversations/{cid}/read -> 204. */
export async function handleRead(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true, allowSuspended: true });
  const cid = await cidOf(params);
  await enforceLimit("conversation.state.uid", auth.user.uid);
  await readConversation(auth.user.uid, cid);
  return noContent();
}

/** POST /api/conversations/{cid}/state {archived} | {hidden: true} | {blocked} -> 204. */
export async function handleState(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true, allowSuspended: true });
  const cid = await cidOf(params);
  const change = await readJson(request, conversationStateSchema);
  await enforceLimit("conversation.state.uid", auth.user.uid);
  await changeConversationState(auth.user.uid, cid, change);
  return noContent();
}

/** GET /api/messages/unread -> UnreadResponse (Valkey; 503 while it fails). */
export async function handleUnread(request: Request): Promise<Response> {
  const auth = await requireUser(request, { checkRevoked: true, allowSuspended: true });
  await enforceLimit("messages.unread.uid", auth.user.uid);
  const body: UnreadResponse = { total: await unreadBadge(auth.user.uid) };
  return json(body);
}
