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

/** The browser's original in the quarantine bucket, deleted once processed. */
export function quarantineObjectKey(uploadId: string): string {
  return `uploads/${uploadId}`;
}

/** Public URL of a variant, or null when no media host is configured (deployed without R2). */
export function photoUrl(env: MediaEnv, listingId: string, photoId: string, variant: PhotoVariant): string | null {
  const base = mediaBaseUrl(env);
  return base ? `${base}/${mediaObjectKey(listingId, photoId, variant)}` : null;
}
