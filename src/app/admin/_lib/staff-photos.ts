import "server-only";
import { smallWidth, type PhotoLike, type PhotoSources } from "@/components/listing/photo";
import { listingIdSchema, type ListingStatus } from "@/lib/contracts/listings";
import { PHOTO_VARIANTS, uploadIdSchema, type PhotoVariant } from "@/lib/contracts/media";
import { photoObjectKey, type PhotoBucket } from "@/lib/media/urls";
import type { ObjectStore } from "@/lib/storage";
import { RETAINED_STATUSES } from "@/lib/uploads/policy";

// Photos of the back office that are not public: a removed listing's variants move to the private
// bucket (purge-quarantine), where no public URL reaches them. The moderation review shows them
// through the staff-only route /photos/{listingId}/{photoId}/{variant} (admin host, moderators
// and admins; no dot in the path, so proxy.ts rewrites it to src/app/admin/photos), which reads the
// private bucket first, then the media bucket (a listing removed within the hour, or a move cut
// short).

/** Largest variant served (memory guard): a WebP of at most 1600 px, far below. */
export const MAX_STAFF_PHOTO_BYTES = 8 * 1024 * 1024;

/** Listings whose photos the review reads through the staff route rather than the public media host. */
export function usesStaffPhotos(status: ListingStatus): boolean {
  return RETAINED_STATUSES.includes(status);
}

/** Same-origin path of a variant on the admin host. */
export function staffPhotoPath(listingId: string, photoId: string, variant: PhotoVariant): string {
  return `/photos/${listingId}/${photoId}/${variant}`;
}

/** photoSources() through the staff route: both variants as `src` + `srcSet`. */
export function staffPhotoSources(listingId: string, photo: PhotoLike, prefer: PhotoVariant = "s"): PhotoSources {
  const small = staffPhotoPath(listingId, photo.id, "s");
  const large = staffPhotoPath(listingId, photo.id, "l");
  const sw = smallWidth(photo);
  const srcSet = sw >= photo.w ? `${large} ${photo.w}w` : `${small} ${sw}w, ${large} ${photo.w}w`;
  return { src: prefer === "s" ? small : large, srcSet, width: photo.w, height: photo.h, large };
}

export interface StaffPhotoTarget {
  listingId: string;
  photoId: string;
  variant: PhotoVariant;
}

/** The route's segments, validated (ids by their schemas, a known variant), or null. */
export function parseStaffPhotoParams(params: Record<string, string | string[] | undefined>): StaffPhotoTarget | null {
  const listingId = listingIdSchema.safeParse(params["listingId"]);
  const photoId = uploadIdSchema.safeParse(params["photoId"]);
  const variant = PHOTO_VARIANTS.find((name) => name === params["variant"]);
  if (!listingId.success || !photoId.success || !variant) return null;
  return { listingId: listingId.data, photoId: photoId.data, variant };
}

const SEARCH_ORDER: readonly PhotoBucket[] = ["private", "media"];

/** The variant's bytes from whichever bucket holds it, or null when neither does. */
export async function readStaffPhoto(store: ObjectStore, { listingId, photoId, variant }: StaffPhotoTarget): Promise<Buffer | null> {
  for (const bucket of SEARCH_ORDER) {
    const body = await store.get(bucket, photoObjectKey(bucket, listingId, photoId, variant), { maxBytes: MAX_STAFF_PHOTO_BYTES });
    if (body) return body.byteLength > MAX_STAFF_PHOTO_BYTES ? null : body;
  }
  return null;
}
