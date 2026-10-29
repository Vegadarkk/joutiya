import { sanitaryNumber, subcategoryById } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import type { ListingPhoto } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UserDoc } from "@/lib/db/schemas";
import { LISTING_ID_ALPHABET, buildSlugId } from "@/lib/listings/ids";
import { dayString, moroccoToday } from "@/lib/listings/rental-availability";
import { DEMO_ENTRIES, DEMO_SELLERS, type DemoEntry, type DemoSeller } from "./catalog";

// Example listings (scripts/seed-demo.ts; owner decision of 2026-10-28): the catalog turned into
// Firestore documents with stable ids, so a second run overwrites the first and the removal finds
// everything without a read. Each one carries `example: true`: labelled "Annonce exemple" on cards
// and pages, never contactable (acceptsContact), no paid boost or ad, out of the sitemap. Listing ids start with "zx" (load test: "zz", "zy"), seller uids with "demo-", photo ids
// with "demo": scripts/launch-check.ts and the purge before launch key on these.

export const DEMO_ID_PREFIX = "zx";
export const DEMO_UID_PREFIX = "demo-";
/** Examples do not expire like a member's listing (60 days): a re-run of the seed renews them. */
export const DEMO_LIFETIME_DAYS = 3650;

const DAY_MS = 86_400_000;

/** `prefix` then n in base 31 on `length` characters (listing and public id alphabet). */
function sequenceId(prefix: string, n: number, length: number): string {
  let rest = n;
  let digits = "";
  for (let index = 0; index < length; index += 1) {
    digits = (LISTING_ID_ALPHABET[rest % LISTING_ID_ALPHABET.length] as string) + digits;
    rest = Math.floor(rest / LISTING_ID_ALPHABET.length);
  }
  return `${prefix}${digits}`;
}

export function demoListingId(index: number): string {
  return sequenceId(DEMO_ID_PREFIX, index, 6);
}

export function demoSellerUid(key: string): string {
  return `${DEMO_UID_PREFIX}${key}`;
}

export function demoSellerPublicId(index: number): string {
  return sequenceId(DEMO_ID_PREFIX, index, 8);
}

/** Upload id of photo `position` of a listing (uploadIdSchema: 8 to 40 alphanumerics). */
export function demoPhotoId(listingId: string, position: number): string {
  return `demo${listingId}p${position}`;
}

export interface DemoPhotoRef {
  listingId: string;
  photoId: string;
  pexelsId: string;
}

/** Every photo of the catalog, with the ids it is stored under. */
export function demoPhotoRefs(entries: readonly DemoEntry[] = DEMO_ENTRIES): DemoPhotoRef[] {
  return entries.flatMap((entry, index) => entry.photos.map((pexelsId, position) => ({ listingId: demoListingId(index), photoId: demoPhotoId(demoListingId(index), position), pexelsId })));
}

/** Source URL of a Pexels photo, at the size of the `l` variant (1600 px). */
export function pexelsUrl(pexelsId: string): string {
  if (!/^\d{1,12}$/.test(pexelsId)) throw new RangeError(`invalid Pexels id ${pexelsId}`);
  return `https://images.pexels.com/photos/${pexelsId}/pexels-photo-${pexelsId}.jpeg?auto=compress&cs=tinysrgb&w=1600`;
}

function sellerOf(key: string): { seller: DemoSeller; index: number } {
  const index = DEMO_SELLERS.findIndex((seller) => seller.key === key);
  if (index < 0) throw new Error(`unknown demo seller ${key}`);
  return { seller: DEMO_SELLERS[index] as DemoSeller, index };
}

/**
 * The catalog's listing number `index`, published `days` before `now`. `photos` are the stored
 * photos of that listing (seed-demo processes them first); without them the listing has none.
 */
export function demoListing(entry: DemoEntry, index: number, now: Date, photos: readonly ListingPhoto[] = []): ListingRecord {
  const sub = subcategoryById(entry.sub);
  if (!sub) throw new Error(`unknown subcategory ${entry.sub}`);
  const city = cityBySlug(entry.city);
  if (!city) throw new Error(`unknown city ${entry.city}`);
  const { seller, index: sellerIndex } = sellerOf(entry.seller);
  const id = demoListingId(index);
  // Spread within the day so listings of the same age do not share a timestamp.
  const at = new Date(now.getTime() - entry.days * DAY_MS - ((index * 37) % 600) * 60_000);
  return {
    id,
    ownerUid: demoSellerUid(seller.key),
    sellerType: seller.type,
    sellerName: seller.name,
    sellerPublicId: demoSellerPublicId(sellerIndex),
    status: "published",
    slugId: buildSlugId({ id, title: entry.title, city: city.nameFr, categoryId: sub.categoryId }),
    title: entry.title,
    description: entry.description,
    categoryId: sub.categoryId,
    subcategoryId: sub.id,
    attributes: entry.attributes,
    ...(sub.condition && entry.condition ? { condition: entry.condition } : {}),
    price: entry.price,
    priceNegotiable: entry.negotiable === true,
    isDonation: entry.donation === true,
    location: { regionCode: city.regionCode, citySlug: city.slug, geo: { lat: city.lat, lng: city.lng } },
    photos: [...photos],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    // No "À la Une": a sponsored mention on an example would be false.
    boosts: {},
    sortAt: at,
    sortSource: "publish",
    // Restricted goods, and food with its ONSSA number, are reviewed by a moderator before publication: shown as reviewed.
    moderation: { state: sub.adultsOnly || sanitaryNumber(sub.id, entry.attributes) ? "human_ok" : "auto_ok", score: 0, flags: [], openReports: 0 },
    example: true,
    // Rentals: periods counted from the seed day, confirmed on that day (fresh for 14 days).
    ...(entry.rentalBlocked ? { rental: { unavailable: entry.rentalBlocked.map(([from, to]) => ({ from: dayString(moroccoToday(now) + from), to: dayString(moroccoToday(now) + to) })), updatedAt: now } } : {}),
    adsEligible: false,
    publishedAt: at,
    expiresAt: new Date(now.getTime() + DEMO_LIFETIME_DAYS * DAY_MS),
    legalHold: [],
    createdAt: at,
    updatedAt: at,
    version: 1,
  } as ListingRecord;
}

export function demoListings(now: Date, photosOf: (listingId: string) => readonly ListingPhoto[] = () => []): ListingRecord[] {
  return DEMO_ENTRIES.map((entry, index) => demoListing(entry, index, now, photosOf(demoListingId(index))));
}

/** The seller's public profile (no Firebase Auth account: nobody signs in as a demo seller). */
export function demoSeller(seller: DemoSeller, index: number, now: Date): UserDoc {
  const city = cityBySlug(seller.city);
  if (!city) throw new Error(`unknown city ${seller.city}`);
  const pro = seller.type === "pro";
  return {
    publicId: demoSellerPublicId(index),
    displayName: seller.name,
    type: seller.type,
    regionCode: city.regionCode,
    citySlug: city.slug,
    ...(seller.bio ? { storefront: { bio: seller.bio } } : {}),
    badges: { emailVerified: true, phoneVerified: pro, proCertified: pro },
    stats: { activeListings: DEMO_ENTRIES.filter((entry) => entry.seller === seller.key).length, responseRate: pro ? 0.95 : 0.8, medianReplyMin: pro ? 20 : 90, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: seller.locale ?? "fr",
    createdAt: new Date(now.getTime() - 90 * DAY_MS),
    updatedAt: now,
  } as UserDoc;
}

export function demoSellers(now: Date): { uid: string; doc: UserDoc }[] {
  return DEMO_SELLERS.map((seller, index) => ({ uid: demoSellerUid(seller.key), doc: demoSeller(seller, index, now) }));
}
