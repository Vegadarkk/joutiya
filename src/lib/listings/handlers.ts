import "server-only";
import { z } from "@/lib/zod";
import { requireUser, type AuthContext } from "@/lib/auth/guards";
import { applyDevice, applyTurnstilePass, deviceOf, jsonResponse } from "@/lib/auth/respond";
import { OWNER_LIST_BUCKETS, createListingSchema, listingPatchSchema, publishListingSchema, type CreateListingResponse, type ListingResponse, type OwnerListingsResponse } from "@/lib/contracts/listings";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { getListing, listOwnerListings } from "@/lib/db/repositories/listings";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json, noContent } from "@/lib/http/route";
import { assertQuotas, DEPOSIT_QUOTAS } from "@/lib/quota/gate";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { isListingId } from "./ids";
import { ownerListingView, toOwnerSummary } from "./owner-view";
import { revealPhone } from "./phone-reveal";
import { changeStatus, createDraft, patchListing, publish, type Actor, type OwnerAction } from "./service";

// Route handlers of /api/listings/** (design §3): thin, every one through requireUser (Origin +
// CSRF on mutations, 401 anonymous, 403 role_missing / account_suspended), the owner check inside
// the service answering 404 for someone else's listing (IDOR). Bodies are strict contracts. Every
// route consumes its per-account limiter after the guard and the body, before the first Firestore
// read (src/config/rate-limits.ts: the Spark daily quotas are shared by the whole site). Deposit
// routes (create, edit, publish, renew, resume) answer 503 once the write quota is degraded
// (quota/gate.ts); pause, sold and removal stay open: they take a listing down.

/** Wizard patches carry a 4 000-character description and the attributes: above the 16 KiB default. */
export const PATCH_MAX_BYTES = 64 * 1024;

type Params = Promise<Record<string, string | string[] | undefined>>;

async function listingIdOf(params: Params): Promise<string> {
  const { id } = await params;
  if (typeof id !== "string" || !isListingId(id)) throw notFound();
  return id;
}

function actorOf(request: Request, auth: AuthContext): Actor {
  return { auth, ip: requestIdentity(request.headers).ip };
}

const mineQuerySchema = z.enum(OWNER_LIST_BUCKETS);
/** Optional JSON body of the phone reveal (the Turnstile token once escalated). */
const revealSchema = z.object({ turnstileToken: turnstileTokenSchema.optional() }).strict();

/**
 * Owner reads are charged in Firestore documents (`listing.owner.read.uid`): one point before the
 * read, so a refused call reads nothing, then the rest once the answer shows what was read. The
 * owner view that a save, a renewal or a resumption answers with is charged the same way; pause
 * and sold are never refused by this budget (they take a listing down) and pay for their view after.
 */
async function chargeOwnerRead(uid: string, documents: number): Promise<void> {
  if (documents > 1) await consumeLimit("listing.owner.read.uid", uid, documents - 1);
}

export async function handleCreate(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, createListingSchema);
  await enforceLimit("listing.new.uid", auth.user.uid);
  await assertQuotas(DEPOSIT_QUOTAS);
  const body: CreateListingResponse = await createDraft(actorOf(request, auth), input);
  return json(body, { status: 201 });
}

export async function handleMine(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  const bucket = mineQuerySchema.safeParse(new URL(request.url).searchParams.get("status") ?? "drafts");
  if (!bucket.success) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "status", code: "invalid_value" }] });
  await enforceLimit("listing.owner.read.uid", auth.user.uid);
  const listings = await listOwnerListings(auth.user.uid, bucket.data);
  await chargeOwnerRead(auth.user.uid, listings.length);
  const now = new Date();
  const body: OwnerListingsResponse = { listings: listings.map((listing) => toOwnerSummary(listing, now)) };
  return json(body);
}

export async function handleGet(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request);
  const id = await listingIdOf(params);
  await enforceLimit("listing.owner.read.uid", auth.user.uid);
  const listing = await getListing(id);
  if (!listing || (listing.ownerUid !== auth.user.uid && !(listing.proId && listing.proId === auth.user.claims.proId))) throw notFound();
  const body: ListingResponse = { listing: await ownerListingView(listing) };
  // The listing, then its uploads: the ready ones are its photos, the others are listed as well.
  await chargeOwnerRead(auth.user.uid, 1 + body.listing.photos.length);
  return json(body);
}

export async function handlePatch(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const patch = await readJson(request, listingPatchSchema, PATCH_MAX_BYTES);
  // Autosave (D2): coalesced client-side, 120 per hour per account, policy open. A listing that is
  // not a draft also consumes listing.edit.uid inside patchListing.
  await enforceLimit("listing.draft.uid", auth.user.uid);
  await assertQuotas(DEPOSIT_QUOTAS);
  await enforceLimit("listing.owner.read.uid", auth.user.uid);
  const body: ListingResponse = { listing: await patchListing(actorOf(request, auth), id, patch) };
  await chargeOwnerRead(auth.user.uid, 1 + body.listing.photos.length);
  return json(body);
}

export async function handleDelete(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  await enforceLimit("listing.status.uid", auth.user.uid);
  await changeStatus(actorOf(request, auth), id, "remove");
  return noContent();
}

export function transitionHandler(action: Exclude<OwnerAction, "remove">): (request: Request, params: Params) => Promise<Response> {
  return async (request, params) => {
    const auth = await requireUser(request, { mutation: true });
    const id = await listingIdOf(params);
    await enforceLimit("listing.status.uid", auth.user.uid);
    // Renew and resume put the listing back online: the quota gate and the owner-read budget may
    // refuse them. Pause and sold take it down: neither does (listing.status.uid bounds them), and
    // their owner view is charged once read, without refusal.
    const takesDown = action === "pause" || action === "sold";
    if (!takesDown) {
      await assertQuotas(DEPOSIT_QUOTAS);
      await enforceLimit("listing.owner.read.uid", auth.user.uid);
    }
    const listing = await changeStatus(actorOf(request, auth), id, action);
    const body: ListingResponse = { listing: await ownerListingView(listing) };
    const documents = 1 + body.listing.photos.length;
    if (takesDown) await consumeLimit("listing.owner.read.uid", auth.user.uid, documents);
    else await chargeOwnerRead(auth.user.uid, documents);
    return json(body);
  };
}

export async function handlePublish(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const input = await readJson(request, publishListingSchema);
  // Every attempt, before the listing is read; the 5 publications a day are counted inside publish().
  await enforceLimit("listing.publish.uid", auth.user.uid);
  await assertQuotas(DEPOSIT_QUOTAS);
  const device = deviceOf(request);
  const outcome = await publish(actorOf(request, auth), request, id, { turnstileToken: input.turnstileToken, device });
  const response = applyDevice(jsonResponse(outcome.response), device);
  return outcome.turnstilePassed ? applyTurnstilePass(response, device) : response;
}

export async function handlePhone(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const input = request.headers.get("content-type") ? await readJson(request, revealSchema) : {};
  await enforceLimit("reveal.call.uid", auth.user.uid);
  const device = deviceOf(request);
  const outcome = await revealPhone(auth, request, id, { turnstileToken: input.turnstileToken, device });
  const response = applyDevice(jsonResponse(outcome.response), device);
  return outcome.turnstilePassed ? applyTurnstilePass(response, device) : response;
}
