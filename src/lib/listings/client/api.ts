import { apiDelete, apiGet, apiPatch, apiPost, apiPut, csrfToken } from "@/lib/auth/client";
import {
  LISTING_API,
  type CreateListingInput,
  type CreateListingResponse,
  type ListingPatch,
  type ListingResponse,
  type OwnerListBucket,
  type OwnerListingsResponse,
  type PublishListingInput,
  type PublishListingResponse,
  type RentalAvailabilityInput,
  type RentalAvailabilityResponse,
} from "@/lib/contracts/listings";
import { MEDIA_API, type SignUploadInput, type SignUploadResponse, type UploadStatusResponse } from "@/lib/contracts/media";
import { CSRF_HEADER } from "@/lib/security/cookies";

// Typed calls of the listings and uploads API (design §3): the wizard and "Mes annonces" call
// exactly these paths with exactly these bodies. Errors are ApiError instances (code translated
// by useApiErrorMessage: Listing.errors, then Auth.errors).

export function createListing(input: CreateListingInput): Promise<CreateListingResponse> {
  return apiPost<CreateListingResponse>(LISTING_API.listings, input);
}

export function getListing(id: string): Promise<ListingResponse> {
  return apiGet<ListingResponse>(LISTING_API.listing(id));
}

export function patchListing(id: string, patch: ListingPatch): Promise<ListingResponse> {
  return apiPatch<ListingResponse>(LISTING_API.listing(id), patch);
}

/**
 * Last-chance save when the page is being unloaded: a `keepalive` request outlives the page
 * (64 KiB body cap, a draft patch is far below). Fire and forget: the answer is never read.
 */
export function patchListingOnUnload(id: string, patch: ListingPatch): void {
  if (typeof fetch !== "function") return;
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  const csrf = csrfToken();
  if (csrf) headers[CSRF_HEADER] = csrf;
  void fetch(LISTING_API.listing(id), { method: "PATCH", credentials: "same-origin", keepalive: true, headers, body: JSON.stringify(patch) }).catch(() => undefined);
}

export function deleteListing(id: string): Promise<void> {
  return apiDelete(LISTING_API.listing(id));
}

export function publishListing(id: string, input: PublishListingInput): Promise<PublishListingResponse> {
  return apiPost<PublishListingResponse>(LISTING_API.publish(id), input);
}

export function listMine(bucket: OwnerListBucket): Promise<OwnerListingsResponse> {
  return apiGet<OwnerListingsResponse>(LISTING_API.mine(bucket));
}

export type OwnerAction = "pause" | "resume" | "sold" | "renew";

export function listingAction(id: string, action: OwnerAction): Promise<ListingResponse> {
  return apiPost<ListingResponse>(LISTING_API[action](id), {});
}

/** A car rental's blocked periods (replaced), or the same ones to confirm they are up to date. */
export function saveAvailability(id: string, input: RentalAvailabilityInput): Promise<RentalAvailabilityResponse> {
  return apiPut<RentalAvailabilityResponse>(LISTING_API.availability(id), input);
}

export function signUpload(input: SignUploadInput): Promise<SignUploadResponse> {
  return apiPost<SignUploadResponse>(MEDIA_API.sign, input);
}

export function completeUpload(id: string): Promise<UploadStatusResponse> {
  return apiPost<UploadStatusResponse>(MEDIA_API.complete(id), {});
}

export function getUpload(id: string): Promise<UploadStatusResponse> {
  return apiGet<UploadStatusResponse>(MEDIA_API.upload(id));
}

export function deleteUpload(id: string): Promise<void> {
  return apiDelete(MEDIA_API.upload(id));
}

/**
 * Waits between two status reads while the pipeline runs: quick at first (an inline or idle worker
 * answers within seconds), then every 5 s (the last delay repeats). About 14 reads in 60 s, not 30:
 * each one is a Firestore read.
 */
export const UPLOAD_POLL_DELAYS_MS: readonly number[] = [1_000, 2_000, 3_000, 5_000];
export const UPLOAD_POLL_MAX_MS = 60_000;

/** The wait before status read number `attempt` (0-based): the schedule, then its last delay. */
export function pollDelay(attempt: number, delays: readonly number[] = UPLOAD_POLL_DELAYS_MS): number {
  return delays[Math.min(attempt, delays.length - 1)] ?? UPLOAD_POLL_MAX_MS;
}

export interface PollOptions {
  /** Backoff schedule (default UPLOAD_POLL_DELAYS_MS). */
  delaysMs?: readonly number[];
  maxMs?: number;
  signal?: AbortSignal;
  /** Injected in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchStatus?: (id: string) => Promise<UploadStatusResponse>;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls GET /api/uploads/{id} with a backoff (1 s, 2 s, 3 s, then every 5 s) while the pipeline
 * runs (max 60 s). Resolves with the final answer, or with the last `processing` answer when the
 * deadline passes (the tile then offers a manual refresh instead of hammering the API).
 */
export async function pollUpload(id: string, options: PollOptions = {}): Promise<UploadStatusResponse> {
  if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const delays = options.delaysMs && options.delaysMs.length > 0 ? options.delaysMs : UPLOAD_POLL_DELAYS_MS;
  const deadline = Date.now() + (options.maxMs ?? UPLOAD_POLL_MAX_MS);
  const wait = options.sleep ?? sleep;
  const fetchStatus = options.fetchStatus ?? getUpload;
  let last: UploadStatusResponse = { status: "processing" };
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    await wait(pollDelay(attempt, delays), options.signal);
    last = await fetchStatus(id);
    if (last.status !== "processing") return last;
  }
  return last;
}
