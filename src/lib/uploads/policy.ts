import "server-only";
import { listingQuotas, type Seller } from "@/config/pricing";
import type { ListingStatus } from "@/lib/contracts/listings";
import { listingPhotoSchema, type UploadStatusResponse } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// Rules shared by the uploads API and the media pipeline: which listings take photos, how many,
// which ones the pipeline attaches itself, and the client view of an upload document.

/**
 * Listings that accept new photos: the ones the owner may still edit (listing service
 * EDITABLE_STATUSES; a unit test keeps both lists equal without importing the service here).
 */
export const PHOTO_TARGET_STATUSES: readonly ListingStatus[] = ["draft", "pending_review", "published", "paused", "expired", "rejected"];

/**
 * Listings the pipeline attaches a ready photo to (never public). A live or expired listing
 * (published, paused, pending_review, expired) gets it through the owner's PATCH instead, where
 * the listing service re-screens live listings: the pipeline never puts a photo on a public page.
 */
export const AUTO_ATTACH_STATUSES: readonly ListingStatus[] = ["draft", "rejected"];

/** Live listings must keep at least one photo (readiness `photos_required`). */
export const LIVE_STATUSES: readonly ListingStatus[] = ["published", "paused", "pending_review"];

/** Photos per listing from the seller type of the listing (D5: individual 10, Pro 20). */
export function maxPhotosOf(listing: Pick<ListingRecord, "sellerType">): number {
  const seller: Seller = listing.sellerType === "pro" ? { type: "pro", plan: "none" } : { type: "individual" };
  return listingQuotas(seller).photosPerListing;
}

/** Public part of an upload document (MEDIA_API answers). `signed` reads as processing. */
export function toStatusResponse(upload: Pick<UploadRecord, "id" | "status" | "width" | "height" | "blurhash" | "hash" | "rejectReason">): UploadStatusResponse {
  if (upload.status === "rejected") return { status: "rejected", rejectReason: upload.rejectReason ?? "expired" };
  if (upload.status !== "ready") return { status: "processing" };
  const photo = listingPhotoSchema.safeParse({ id: upload.id, w: upload.width, h: upload.height, blurhash: upload.blurhash, ...(upload.hash ? { hash: upload.hash } : {}) });
  return photo.success ? { status: "ready", photo: photo.data } : { status: "processing" };
}
