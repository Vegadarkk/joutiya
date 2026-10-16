import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/auth/client";
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
} from "@/lib/contracts/listings";
import { MEDIA_API, type SignUploadInput, type SignUploadResponse, type UploadStatusResponse } from "@/lib/contracts/media";

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

export const UPLOAD_POLL_MS = 2_000;
export const UPLOAD_POLL_MAX_MS = 60_000;

export interface PollOptions {
  intervalMs?: number;
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
 * Polls GET /api/uploads/{id} every 2 s while the pipeline runs (max 60 s). Resolves with the
 * final answer, or with the last `processing` answer when the deadline passes (the tile then
 * offers a manual refresh instead of hammering the API).
 */
export async function pollUpload(id: string, options: PollOptions = {}): Promise<UploadStatusResponse> {
  const interval = options.intervalMs ?? UPLOAD_POLL_MS;
  const deadline = Date.now() + (options.maxMs ?? UPLOAD_POLL_MAX_MS);
  const wait = options.sleep ?? sleep;
  const fetchStatus = options.fetchStatus ?? getUpload;
  let last: UploadStatusResponse = { status: "processing" };
  while (Date.now() < deadline) {
    await wait(interval, options.signal);
    last = await fetchStatus(id);
    if (last.status !== "processing") return last;
  }
  return last;
}
