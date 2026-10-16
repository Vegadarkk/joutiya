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
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { isListingId } from "./ids";
import { ownerListingView, toOwnerSummary } from "./owner-view";
import { revealPhone } from "./phone-reveal";
import { changeStatus, createDraft, patchListing, publish, type Actor, type OwnerAction } from "./service";

// Route handlers of /api/listings/** (design §3): thin, every one through requireUser (Origin +
// CSRF on mutations, 401 anonymous, 403 role_missing / account_suspended), the owner check inside
// the service answering 404 for someone else's listing (IDOR). Bodies are strict contracts.

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

export async function handleCreate(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, createListingSchema);
  const body: CreateListingResponse = await createDraft(actorOf(request, auth), input);
  return json(body, { status: 201 });
}

export async function handleMine(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  const bucket = mineQuerySchema.safeParse(new URL(request.url).searchParams.get("status") ?? "drafts");
  if (!bucket.success) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "status", code: "invalid_value" }] });
  const listings = await listOwnerListings(auth.user.uid, bucket.data);
  const now = new Date();
  const body: OwnerListingsResponse = { listings: listings.map((listing) => toOwnerSummary(listing, now)) };
  return json(body);
}

export async function handleGet(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request);
  const id = await listingIdOf(params);
  const listing = await getListing(id);
  if (!listing || (listing.ownerUid !== auth.user.uid && !(listing.proId && listing.proId === auth.user.claims.proId))) throw notFound();
  const body: ListingResponse = { listing: await ownerListingView(listing) };
  return json(body);
}

export async function handlePatch(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const patch = await readJson(request, listingPatchSchema, PATCH_MAX_BYTES);
  // Autosave (D2): coalesced client-side, 120 per hour per account, policy open.
  await enforceLimit("listing.draft.uid", auth.user.uid);
  const body: ListingResponse = { listing: await patchListing(actorOf(request, auth), id, patch) };
  return json(body);
}

export async function handleDelete(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  await changeStatus(actorOf(request, auth), id, "remove");
  return noContent();
}

export function transitionHandler(action: Exclude<OwnerAction, "remove">): (request: Request, params: Params) => Promise<Response> {
  return async (request, params) => {
    const auth = await requireUser(request, { mutation: true });
    const id = await listingIdOf(params);
    const listing = await changeStatus(actorOf(request, auth), id, action);
    const body: ListingResponse = { listing: await ownerListingView(listing) };
    return json(body);
  };
}

export async function handlePublish(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const input = await readJson(request, publishListingSchema);
  const device = deviceOf(request);
  const outcome = await publish(actorOf(request, auth), request, id, { turnstileToken: input.turnstileToken, device });
  const response = applyDevice(jsonResponse(outcome.response), device);
  return outcome.turnstilePassed ? applyTurnstilePass(response, device) : response;
}

export async function handlePhone(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const input = request.headers.get("content-type") ? await readJson(request, revealSchema) : {};
  const device = deviceOf(request);
  const outcome = await revealPhone(auth, request, id, { turnstileToken: input.turnstileToken, device });
  const response = applyDevice(jsonResponse(outcome.response), device);
  return outcome.turnstilePassed ? applyTurnstilePass(response, device) : response;
}
