import "server-only";
import { requireUser } from "@/lib/auth/guards";
import {
  cidSchema,
  conversationStateSchema,
  sendMessageSchema,
  startConversationSchema,
  type SendMessageResponse,
  type StartConversationResponse,
  type UnreadResponse,
} from "@/lib/contracts/messaging";
import { serverEnv } from "@/lib/env";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json, noContent } from "@/lib/http/route";
import type { RateLimitId } from "@/config/rate-limits";
import { assertQuotas } from "@/lib/quota/gate";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { assertLimit, consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { conversationId } from "./ids";
import { MESSAGING_QUOTAS, changeConversationState, readConversation, sendMessage, startConversation, unreadBadge, type MessagingActor } from "./service";

// Route handlers of /api/conversations/** and /api/messages/unread (design D3-D9, §4). Members
// only (staff accounts never message, D8): Origin + CSRF on every POST. Writing (start, send)
// refuses a suspended account (403 account_suspended); reading, the read receipt, archive, delete
// for me and block stay open to it (D9: a suspended user still reads his conversations). Order:
// guard, body, the send limiters, quota gate, Turnstile, then the first Firestore read.

type Params = Promise<Record<string, string | string[] | undefined>>;

/** Large enough for a 2 000-character message in Arabic (UTF-8, JSON escapes) and a Turnstile token. */
export const MESSAGE_BODY_MAX = 32 * 1024;

/**
 * The send limiters (D4, audit D1a-01): a burst per minute, an hour and a day per account, and an
 * hour per account and thread. Consumed together (one round trip), asserted in that order; every
 * one is open (a Valkey outage never blocks a reply).
 */
async function enforceSendLimits(uid: string, cid: string): Promise<void> {
  const checks: readonly (readonly [RateLimitId, string])[] = [
    ["message.send.uid", uid],
    ["message.send.hour.uid", uid],
    ["message.send.day.uid", uid],
    ["message.send.thread", `${uid}:${cid}`],
  ];
  const outcomes = await Promise.all(checks.map(([id, key]) => consumeLimit(id, key)));
  checks.forEach(([id], index) => assertLimit(id, outcomes[index]!));
}

async function cidOf(params: Params): Promise<string> {
  const { cid } = await params;
  const parsed = cidSchema.safeParse(cid);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

const actorOf = (auth: Awaited<ReturnType<typeof requireUser>>): MessagingActor => ({ uid: auth.user.uid, claims: auth.user.claims });

/** POST /api/conversations {listingId, text, turnstileToken} -> 201 StartConversationResponse. */
export async function handleStart(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, startConversationSchema, MESSAGE_BODY_MAX);
  await enforceSendLimits(auth.user.uid, conversationId(input.listingId, auth.user.uid));
  await assertQuotas(MESSAGING_QUOTAS);
  // Turnstile on every first message (AF §6), before any read: the token is single use.
  const identity = requestIdentity(request.headers);
  const check = await verifyTurnstile(input.turnstileToken, { action: "message", remoteIp: identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!check.ok) throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: check.codes } });
  const body: StartConversationResponse = await startConversation(actorOf(auth), { listingId: input.listingId, text: input.text });
  return json(body, { status: 201 });
}

/** POST /api/conversations/{cid}/messages {text} -> 201 SendMessageResponse. */
export async function handleSend(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const cid = await cidOf(params);
  const input = await readJson(request, sendMessageSchema, MESSAGE_BODY_MAX);
  await enforceSendLimits(auth.user.uid, cid);
  await assertQuotas(MESSAGING_QUOTAS);
  const body: SendMessageResponse = await sendMessage(actorOf(auth), cid, input.text);
  return json(body, { status: 201 });
}

/** POST /api/conversations/{cid}/read -> 204. */
export async function handleRead(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, allowSuspended: true });
  const cid = await cidOf(params);
  await enforceLimit("conversation.state.uid", auth.user.uid);
  await readConversation(auth.user.uid, cid);
  return noContent();
}

/** POST /api/conversations/{cid}/state {archived} | {hidden: true} | {blocked} -> 204. */
export async function handleState(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, allowSuspended: true });
  const cid = await cidOf(params);
  const change = await readJson(request, conversationStateSchema);
  await enforceLimit("conversation.state.uid", auth.user.uid);
  await changeConversationState(auth.user.uid, cid, change);
  return noContent();
}

/** GET /api/messages/unread -> UnreadResponse (Valkey; 503 while it fails). */
export async function handleUnread(request: Request): Promise<Response> {
  const auth = await requireUser(request, { allowSuspended: true });
  await enforceLimit("messages.unread.uid", auth.user.uid);
  const body: UnreadResponse = { total: await unreadBadge(auth.user.uid) };
  return json(body);
}
