import "server-only";
import type { OwnerCatalogue, OwnerListing, OwnerListingSummary, OwnerPaymentLink, OwnerPhoto } from "@/lib/contracts/listings";
import type { UploadStatus } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { listUploadsByTarget, type UploadRecord } from "@/lib/db/repositories/uploads";
import { ownerPaymentLink } from "@/lib/pro/seller-payment-rules";
import { MANUAL_ATTACH_STATUSES } from "@/lib/uploads/policy";
import { datedRental } from "@/config/categories";
import { rentalAvailabilityOf } from "./availability";
import { canRenew } from "./lifecycle";
import { nextPromoFrom, promoView, referencePrices } from "./promo";

// Owner's view of a listing (contracts OwnerListing / OwnerListingSummary): the document's fields
// the wizard edits, with the photos' processing status merged from `uploads` (processing and
// rejected photos are not on the listing yet; the wizard shows them next to the ready ones).

const iso = (date: Date | undefined): string | null => (date ? date.toISOString() : null);

/** Uploads the view needs besides the attached photos (those come from the listing itself). */
const PENDING_STATUSES: readonly UploadStatus[] = ["signed", "processing", "rejected"];

/**
 * A ready upload not on the listing waits for the owner's save: listings in MANUAL_ATTACH_STATUSES
 * (published, paused, expired, held) never get a photo from the pipeline. Under a legal hold a
 * detached photo keeps its document as evidence: it is not offered again.
 */
function showsUnattachedReady(listing: Pick<ListingRecord, "status" | "legalHold">): boolean {
  return MANUAL_ATTACH_STATUSES.includes(listing.status) && listing.legalHold.length === 0;
}

/**
 * Photos in wizard order: the listing's ready photos first, then the other uploads by creation
 * date. A ready upload that waits for the owner's save reads as `processing`: the wizard polls it,
 * gets it ready and puts it in the photo order of the next save (an unsaved change, not a photo
 * the listing already has). Signed and processing uploads read as such, rejected ones with their reason.
 */
export function mergePhotos(listing: Pick<ListingRecord, "photos" | "status" | "legalHold">, uploads: readonly UploadRecord[]): OwnerPhoto[] {
  const faces = new Map(uploads.map((upload) => [upload.id, upload.checks?.faces ?? 0]));
  const photos: OwnerPhoto[] = listing.photos.map((photo) => {
    const found = faces.get(photo.id) ?? 0;
    return { id: photo.id, status: "ready", w: photo.w, h: photo.h, blurhash: photo.blurhash, ...(found > 0 ? { faces: found } : {}) };
  });
  const attached = new Set(listing.photos.map((photo) => photo.id));
  const unattachedReady = showsUnattachedReady(listing);
  const pending = uploads.filter((upload) => !attached.has(upload.id) && (upload.status !== "ready" || unattachedReady)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
    sellerType: listing.sellerType,
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
    variants: listing.variants ?? null,
    stock: listing.stock ?? null,
    moderation: { state: listing.moderation.state, flags: listing.moderation.flags },
    version: listing.version,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    publishedAt: iso(listing.publishedAt),
    expiresAt: iso(listing.expiresAt),
  };
}

function ownerPaymentLinkView(listing: ListingRecord, now: Date): OwnerPaymentLink {
  const { url, pending } = ownerPaymentLink(listing.paymentLink, now);
  return { url, pending: pending ? { ...pending, activeFrom: pending.activeFrom.toISOString() } : null };
}

function ownerCatalogue(listing: ListingRecord, now: Date): OwnerCatalogue {
  return {
    stock: listing.stock ?? null,
    variants: listing.variants ?? null,
    promo: promoView(listing.promo, now),
    references: Object.fromEntries(referencePrices(listing, now)),
    promoFrom: nextPromoFrom(listing, now).toISOString(),
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
    ...(datedRental(listing.subcategoryId) ? { rental: rentalAvailabilityOf(listing) } : {}),
    ...(listing.sellerType === "pro" && !listing.isDonation ? { catalogue: ownerCatalogue(listing, now) } : {}),
    ...(listing.sellerType === "pro" ? { sectionId: listing.sectionId ?? null, paymentLink: ownerPaymentLinkView(listing, now) } : {}),
  };
}

/** Statuses the wizard edits a draft in: the attached photos' checks (faces) are read for the crop proposal. */
const DRAFT_STATUSES: readonly ListingRecord["status"][] = ["draft", "rejected"];

/**
 * Owner view with the uploads of the listing loaded: the pending ones only on a read-only listing,
 * every status where the wizard edits it (a ready upload may wait for the owner's save, and the
 * attached photos' face counts drive the crop proposal).
 */
export async function ownerListingView(listing: ListingRecord): Promise<OwnerListing> {
  const everyStatus = showsUnattachedReady(listing) || DRAFT_STATUSES.includes(listing.status);
  const uploads = await listUploadsByTarget(listing.id, everyStatus ? undefined : PENDING_STATUSES);
  return toOwnerListing(listing, uploads);
}
