import "server-only";
import type { OwnerListing, OwnerListingSummary, OwnerPhoto } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { listUploadsByTarget, type UploadRecord } from "@/lib/db/repositories/uploads";
import { canRenew } from "./lifecycle";

// Owner's view of a listing (contracts OwnerListing / OwnerListingSummary): the document's fields
// the wizard edits, with the photos' processing status merged from `uploads` (processing and
// rejected photos are not on the listing yet; the wizard shows them next to the ready ones).

const iso = (date: Date | undefined): string | null => (date ? date.toISOString() : null);

/** Photos in wizard order: the listing's ready photos first, then uploads still processing, then the rejected ones. */
export function mergePhotos(listing: Pick<ListingRecord, "photos">, uploads: readonly UploadRecord[]): OwnerPhoto[] {
  const photos: OwnerPhoto[] = listing.photos.map((photo) => ({ id: photo.id, status: "ready", w: photo.w, h: photo.h, blurhash: photo.blurhash }));
  const attached = new Set(listing.photos.map((photo) => photo.id));
  const pending = uploads.filter((upload) => !attached.has(upload.id) && upload.status !== "ready").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const upload of pending) {
    if (upload.status === "rejected") photos.push({ id: upload.id, status: "rejected", ...(upload.rejectReason ? { rejectReason: upload.rejectReason } : {}) });
    else photos.push({ id: upload.id, status: upload.status === "signed" ? "signed" : "processing" });
  }
  return photos;
}

export function toOwnerListing(listing: ListingRecord, uploads: readonly UploadRecord[]): OwnerListing {
  return {
    id: listing.id,
    slugId: listing.slugId ?? null,
    status: listing.status,
    pausedReason: listing.pausedReason ?? null,
    categoryId: listing.categoryId ?? null,
    subcategoryId: listing.subcategoryId ?? null,
    title: listing.title,
    description: listing.description,
    attributes: listing.attributes,
    condition: listing.condition ?? null,
    price: listing.price,
    priceNegotiable: listing.priceNegotiable,
    isDonation: listing.isDonation,
    location: listing.location ? { regionCode: listing.location.regionCode, citySlug: listing.location.citySlug, ...(listing.location.district ? { district: listing.location.district } : {}) } : null,
    photos: mergePhotos(listing, uploads),
    contact: { showPhone: listing.contact.showPhone, whatsapp: listing.contact.whatsapp },
    sensitiveDeclaration: listing.moderation.sensitiveDeclaration ? { kind: listing.moderation.sensitiveDeclaration.kind, at: listing.moderation.sensitiveDeclaration.at.toISOString() } : null,
    moderation: { state: listing.moderation.state, flags: listing.moderation.flags },
    version: listing.version,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    publishedAt: iso(listing.publishedAt),
    expiresAt: iso(listing.expiresAt),
  };
}

export function toOwnerSummary(listing: ListingRecord, now = new Date()): OwnerListingSummary {
  return {
    id: listing.id,
    slugId: listing.slugId ?? null,
    status: listing.status,
    title: listing.title,
    price: listing.price,
    isDonation: listing.isDonation,
    categoryId: listing.categoryId ?? null,
    subcategoryId: listing.subcategoryId ?? null,
    citySlug: listing.location?.citySlug ?? null,
    thumb: listing.photos[0] ?? null,
    photoCount: listing.photos.length,
    moderation: { state: listing.moderation.state, flags: listing.moderation.flags },
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    publishedAt: iso(listing.publishedAt),
    expiresAt: iso(listing.expiresAt),
    canRenew: canRenew(listing, now),
  };
}

/** Owner view with the uploads of the listing loaded. */
export async function ownerListingView(listing: ListingRecord): Promise<OwnerListing> {
  const uploads = await listUploadsByTarget(listing.id);
  return toOwnerListing(listing, uploads);
}
