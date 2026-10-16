import "server-only";
import type { PhotoVariant } from "@/lib/contracts/media";
import { mediaBaseUrl } from "@/lib/storage/keys";

// Object keys and public URLs of photos (design D6, D11). Keys are built from validated ids
// (uploadIdSchema, LISTING_ID_PATTERN) and checked again by every ObjectStore (assertObjectKey).

export const MEDIA_CONTENT_TYPE = "image/webp";
/** Variant keys never change (photoId = uploadId): cache for a year, immutable. */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

type MediaEnv = NonNullable<Parameters<typeof mediaBaseUrl>[0]>;

/** `listings/{listingId}/{photoId}-{variant}.webp` in the media bucket. */
export function mediaObjectKey(listingId: string, photoId: string, variant: PhotoVariant): string {
  return `${listingMediaPrefix(listingId)}${photoId}-${variant}.webp`;
}

/** Common prefix of a listing's variants (purge of a removed listing). */
export function listingMediaPrefix(listingId: string): string {
  return `listings/${listingId}/`;
}

/**
 * Prefix of a removed listing's photos in the private bucket (never public). purge-quarantine
 * moves them there, keeping the rest of the key; retention-purge deletes them with the listing
 * (removal + 12 months). No lifecycle rule may cover it: a legal hold extends the retention.
 */
export const RETAINED_MEDIA_PREFIX = "removed/";

/** Buckets that hold photo variants: `media` (public) or `private` (a removed listing's). */
export type PhotoBucket = "media" | "private";

/** `removed/listings/{listingId}/{photoId}-{variant}.webp` in the private bucket. */
export function retainedObjectKey(listingId: string, photoId: string, variant: PhotoVariant): string {
  return `${RETAINED_MEDIA_PREFIX}${mediaObjectKey(listingId, photoId, variant)}`;
}

/** Key of a variant in either photo bucket. */
export function photoObjectKey(bucket: PhotoBucket, listingId: string, photoId: string, variant: PhotoVariant): string {
  return bucket === "media" ? mediaObjectKey(listingId, photoId, variant) : retainedObjectKey(listingId, photoId, variant);
}

/** `finalKey` of an upload document (variants add `-{variant}.webp`) for the bucket its variants are in. */
export function photoFinalKey(bucket: PhotoBucket, listingId: string, photoId: string): string {
  return `${bucket === "media" ? "" : RETAINED_MEDIA_PREFIX}${listingMediaPrefix(listingId)}${photoId}`;
}

/** The browser's original in the quarantine bucket, deleted once processed. */
export function quarantineObjectKey(uploadId: string): string {
  return `uploads/${uploadId}`;
}

/** Public URL of a variant, or null when no media host is configured (deployed without R2). */
export function photoUrl(env: MediaEnv, listingId: string, photoId: string, variant: PhotoVariant): string | null {
  const base = mediaBaseUrl(env);
  return base ? `${base}/${mediaObjectKey(listingId, photoId, variant)}` : null;
}
