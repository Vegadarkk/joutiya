import "server-only";
import { datedRental, type Condition } from "@/config/categories";
import { REVIEWS_PAGE } from "@/config/reviews";
import { DEFAULT_BANNER, type BannerKey } from "@/config/storefront";
import { cardPromo, isSoldOut, priceRange, type CardPromo, type ListingVariants, type PromoView, type ShopSection } from "@/lib/contracts/catalog";
import type { ListingAttributes, ListingStatus, RentalAvailability } from "@/lib/contracts/listings";
import type { PhotoVariant } from "@/lib/contracts/photo-variants";
import type { RatingSummary, ReviewPage } from "@/lib/contracts/reviews";
import { COLLECTIONS } from "@/lib/db/schemas";
import { getListing, listPublishedByOwner, type ListingRecord } from "@/lib/db/repositories/listings";
import { findUserByPublicId, getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { getSellerPayments } from "@/lib/config/runtime";
import type { PublicShopPayment } from "@/lib/contracts/seller-payment";
import { getProProfile, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { publicShopPayment } from "@/lib/pro/seller-payment";
import { db } from "@/lib/firebase/admin";
import { aggregationReads, consume } from "@/lib/quota";
import { assertQuotas, PUBLIC_READ_QUOTAS } from "@/lib/quota/gate";
import { storefrontShown } from "@/lib/pro/lifecycle";
import { PRO_ID_PATTERN, type ProSector, type RentalAgency } from "@/lib/pro/profile-schema";
import { sellerReviews } from "@/lib/reviews/seller";
import { ratingSummary } from "@/lib/reviews/views";
import { rentalAvailabilityOf } from "./availability";
import { cardFactsField, cardFactsOf, type CardFacts } from "./card-facts";
import { promoView } from "./promo";
import { buildSlugId, parseSlugId } from "./ids";

// Public reads (design §4 public.ts): the listing page by its `{slug}-{id}` segment and the
// seller's profile by publicId. No uid leaves these functions' return values except inside the
// records the page renders server-side (never serialized to the client as such): the pages render
// the `Public*` views below, which carry only what the HTML shows (no uid, moderation, phone).

/** Statuses the public page still renders (with a banner when not published, D14). */
export const PUBLIC_STATES = ["published", "paused", "sold", "expired"] as const satisfies readonly ListingStatus[];
export type PublicState = (typeof PUBLIC_STATES)[number];

export interface PublicListingLookup {
  listing: ListingRecord;
  /** The stored `slugId`; the page 301s to it when `redirect` is true. */
  canonicalSlugId: string;
  /** The segment's slug differs from the canonical one (or the segment was a bare id). */
  redirect: boolean;
  /** `published`, or the reason the page shows a banner instead of the contact actions. */
  state: PublicState;
}

function isPublicState(status: ListingStatus): status is PublicState {
  return (PUBLIC_STATES as readonly string[]).includes(status);
}

/**
 * Whether the public may see a listing: a public status and not hidden by a report's strong signal
 * (phase 5, D11: `moderation.hiddenBy`). The phone reveal and new conversations check it too.
 */
export function isPubliclyVisible(listing: Pick<ListingRecord, "status" | "moderation">): boolean {
  return isPublicState(listing.status) && !listing.moderation.hiddenBy;
}

/**
 * Whether a buyer may reach the seller from this listing (message, phone, appointment, payment):
 * never on an example listing (src/lib/demo), which only shows what a listing of its kind looks like.
 * Every contact entry point checks it next to the listing's status.
 */
export function acceptsContact(listing: Pick<ListingRecord, "example">): boolean {
  return listing.example !== true;
}

/**
 * The listing behind a URL segment: null (404) when the id is malformed, the document missing, the
 * listing hidden by a report (D11), or never/no longer public (draft, pending_review, rejected, removed, purged). Throws
 * once Firestore reads are degraded (src/lib/quota/gate.ts): an ISR revalidation then fails and
 * Next keeps serving the last page it generated. Only the ISR listing page calls it.
 */
export async function getPublishedBySlugId(segment: string): Promise<PublicListingLookup | null> {
  // Ids are lower case: a segment retyped in capitals still finds its listing (then 301s).
  const parsed = parseSlugId(segment.toLowerCase());
  if (!parsed) return null;
  await assertQuotas(PUBLIC_READ_QUOTAS);
  const listing = await getListing(parsed.id);
  if (!listing || !isPublicState(listing.status) || listing.moderation.hiddenBy) return null;
  const canonicalSlugId = listing.slugId ?? buildSlugId({ id: listing.id, title: listing.title, categoryId: listing.categoryId });
  return { listing, canonicalSlugId, redirect: segment !== canonicalSlugId, state: listing.status };
}

/** Locale-prefixed path of a listing page (the canonical URL, the redirect target, revalidation). */
export function listingPath(locale: string, slugId: string): string {
  return `/${locale}/annonce/${slugId}`;
}

export function profilePath(locale: string, publicId: string): string {
  return `/${locale}/profil/${publicId}`;
}

export interface PublicProfile {
  publicId: string;
  displayName: string;
  /** Month of registration, "YYYY-MM" (never the exact date: seniority only). */
  memberSince: string;
  badges: UserRecord["badges"];
  sellerType: UserRecord["type"];
  /** Published listings, newest first. */
  listings: ListingRecord[];
}

export function memberSince(createdAt: Date): string {
  return `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Accounts that have a public face: activated, neither closed nor banned, nor restricted by a
 * report's strong signal (phase 5, D11). Suspended: the profile stays, without listings.
 */
export function isVisibleAccount(user: UserRecord): boolean {
  return user.status !== "closed" && user.status !== "banned" && user.status !== "restricted" && user.activation === "done";
}

/** Published listings of a seller that are not hidden by a report (D11). */
async function listVisibleByOwner(uid: string, limit: number): Promise<ListingRecord[]> {
  return (await listPublishedByOwner(uid, limit)).filter((listing) => !listing.moderation.hiddenBy);
}

/** Public profile of a seller by publicId, or null (unknown id, closed, banned or restricted account). */
export async function getProfile(publicId: string, limit = 24): Promise<PublicProfile | null> {
  const user = await findUserByPublicId(publicId);
  if (!user || !isVisibleAccount(user)) return null;
  const listings = user.status === "suspended" ? [] : await listVisibleByOwner(user.uid, limit);
  return { publicId: user.publicId, displayName: user.displayName, memberSince: memberSince(user.createdAt), badges: user.badges, sellerType: user.type, listings };
}

export { listPublishedByOwner };

// ---- Views rendered by the public pages ------------------------------------------------------

export interface PublicPhoto {
  id: string;
  /** Size of the `l` variant (the pipeline stores it); `s` is derived from it. */
  w: number;
  h: number;
  blurhash: string;
  /** Variants stored (D6); absent on photos from before `m` (LEGACY_PHOTO_VARIANTS). */
  variants?: readonly PhotoVariant[];
}

export interface PublicListing {
  id: string;
  slugId: string;
  state: PublicState;
  title: string;
  description: string;
  categoryId: string;
  subcategoryId: string;
  attributes: ListingAttributes;
  condition: Condition | null;
  /** Integer MAD; null = "à discuter" (D4). */
  price: number | null;
  priceNegotiable: boolean;
  isDonation: boolean;
  location: { regionCode: string; citySlug: string; district: string | null };
  photos: PublicPhoto[];
  /** Which contact actions exist; the number itself only comes from POST /api/listings/{id}/phone. */
  contact: { showPhone: boolean; whatsapp: boolean };
  seller: { publicId: string; name: string; type: UserRecord["type"] };
  /** Example listing (src/lib/demo): labelled, no contact action, not indexed by search engines. */
  example: boolean;
  /** Rentals by dates (cars, holiday homes): the owner's declared availability (rental pack §3); null otherwise. */
  rental: RentalAvailability | null;
  /** A Pro's declared stock or variants (catalogue §2-3); null when the listing has neither. */
  catalogue: PublicCatalogue | null;
  /** ISO 8601. */
  publishedAt: string;
  sortAt: string;
  updatedAt: string;
}

export interface PublicCatalogue {
  /** Without variants: the declared stock (null: not tracked). */
  stock: number | null;
  variants: ListingVariants | null;
  /** Current or scheduled promotion (the page shows it while it runs). */
  promo: PromoView | null;
}

function catalogueOf(record: ListingRecord, now: Date): PublicCatalogue | null {
  const promo = promoView(record.promo, now);
  if (record.sellerType !== "pro" || record.isDonation || (record.variants === undefined && record.stock === undefined && !promo)) return null;
  return { stock: record.variants ? null : (record.stock ?? null), variants: record.variants ?? null, promo };
}

/**
 * Card price and stock marks: the lowest price of the combinations (« à partir de » when they
 * differ), sold out when the declared stock is 0 everywhere (decision 1: still online).
 */
export function cardCatalogue(record: Pick<ListingRecord, "price" | "isDonation" | "variants" | "stock" | "promo">, now = new Date()): { price: number | null; soldOut?: true; priceFrom?: true; promo?: CardPromo } {
  const range = record.variants ? priceRange(record) : null;
  const promo = cardPromo(promoView(record.promo, now), now.getTime());
  return {
    price: range ? range.min : record.price,
    ...(isSoldOut(record) ? { soldOut: true as const } : {}),
    ...(range && range.max > range.min ? { priceFrom: true as const } : {}),
    ...(promo ? { promo } : {}),
  };
}

/** What a listing card shows (profile grid; search results in phase 4). */
export interface PublicListingCard {
  id: string;
  slugId: string;
  title: string;
  subcategoryId: string | null;
  price: number | null;
  priceNegotiable: boolean;
  isDonation: boolean;
  citySlug: string | null;
  photo: PublicPhoto | null;
  photoCount: number;
  sellerType: UserRecord["type"];
  /** ISO 8601: the date shown on the card (publication, or renewal). */
  sortAt: string;
  /** Key numbers under the title and the exclusive mandate (card-facts.ts); absent = none. */
  facts?: CardFacts;
  /** Example listing: "Exemple" label, no favorite action. */
  example?: true;
  /** Pro catalogue: declared stock 0 everywhere (« Épuisé »). */
  soldOut?: true;
  /** Combinations at different prices: `price` is the lowest (« À partir de »). */
  priceFrom?: true;
  /** A promotion running when the card was built. */
  promo?: CardPromo;
}

function publicPhotos(record: ListingRecord): PublicPhoto[] {
  return record.photos.map(({ id, w, h, blurhash, variants }) => ({ id, w, h, blurhash, ...(variants ? { variants } : {}) }));
}

/**
 * The page's view of a public listing, or null when a field every published listing has is missing
 * (a malformed document is a 404, never a half-rendered page).
 */
export function toPublicListing(record: ListingRecord, state: PublicState, slugId: string): PublicListing | null {
  const { location, categoryId, subcategoryId } = record;
  if (!location || !categoryId || !subcategoryId) return null;
  const publishedAt = record.publishedAt ?? record.sortAt;
  return {
    id: record.id,
    slugId,
    state,
    title: record.title,
    description: record.description,
    categoryId,
    subcategoryId,
    attributes: record.attributes,
    condition: record.condition ?? null,
    price: record.price,
    priceNegotiable: record.priceNegotiable,
    isDonation: record.isDonation,
    location: { regionCode: location.regionCode, citySlug: location.citySlug, district: location.district ?? null },
    photos: publicPhotos(record),
    contact: { showPhone: record.contact.showPhone, whatsapp: record.contact.whatsapp },
    seller: { publicId: record.sellerPublicId, name: record.sellerName, type: record.sellerType },
    example: record.example === true,
    rental: datedRental(subcategoryId) ? rentalAvailabilityOf(record) : null,
    catalogue: catalogueOf(record, new Date()),
    publishedAt: publishedAt.toISOString(),
    sortAt: record.sortAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Card view of a listing; null without a canonical slug (never published: no public URL). */
export function toPublicCard(record: ListingRecord): PublicListingCard | null {
  if (!record.slugId) return null;
  const photos = publicPhotos(record);
  return {
    id: record.id,
    slugId: record.slugId,
    title: record.title,
    subcategoryId: record.subcategoryId ?? null,
    priceNegotiable: record.priceNegotiable,
    isDonation: record.isDonation,
    ...cardCatalogue(record),
    citySlug: record.location?.citySlug ?? null,
    photo: photos[0] ?? null,
    photoCount: photos.length,
    sellerType: record.sellerType,
    sortAt: record.sortAt.toISOString(),
    ...cardFactsField(cardFactsOf(record.subcategoryId, (id) => record.attributes[id])),
    ...(record.example ? { example: true as const } : {}),
  };
}

export interface PublicSeller {
  publicId: string;
  displayName: string;
  sellerType: UserRecord["type"];
  /** "YYYY-MM". */
  memberSince: string;
  badges: UserRecord["badges"];
  /** The city the member chose to show on the profile, if any. */
  citySlug: string | null;
  /** Listings online right now (count aggregation: one read per 1 000). */
  publishedCount: number;
  /** Storefront (vitrine-avis §1): the "about" text, if any, and the house banner. */
  bio: string | null;
  bannerKey: BannerKey;
  /** Verified reviews (vitrine-avis §2): published ratings only; none shown while suspended. */
  rating: RatingSummary;
}

/**
 * Listings of a seller in `published` status: one aggregation read per 1 000 index entries (equality
 * filters only; the (ownerUid, status, sortAt) composite index serves it).
 */
export async function countPublishedByOwner(uid: string): Promise<number> {
  const result = await db().collection(COLLECTIONS.listings).where("ownerUid", "==", uid).where("status", "==", "published").count().get();
  const count = result.data().count;
  void consume("firestore.reads", aggregationReads(count));
  return count;
}

function toSeller(user: UserRecord, publishedCount: number): PublicSeller {
  return {
    publicId: user.publicId,
    displayName: user.displayName,
    sellerType: user.type,
    memberSince: memberSince(user.createdAt),
    badges: user.badges,
    citySlug: user.citySlug ?? null,
    publishedCount,
    bio: user.storefront?.bio ?? null,
    bannerKey: user.storefront?.bannerKey ?? DEFAULT_BANNER,
    rating: user.status === "suspended" ? ratingSummary({ ...user.stats, ratingCount: 0 }) : ratingSummary(user.stats),
  };
}

/** Seller card of the listing page, or null when the account has no public face any more. */
export async function getSeller(ownerUid: string): Promise<PublicSeller | null> {
  const user = await getUserRecord(ownerUid);
  if (!user || !isVisibleAccount(user)) return null;
  const count = user.status === "suspended" ? 0 : await countPublishedByOwner(user.uid);
  return toSeller(user, count);
}

export interface PublicProfileView extends PublicSeller {
  /** Published listings as cards, newest first (at most `limit`). */
  listings: PublicListingCard[];
  /** The newest published reviews (no query while the seller has none). */
  reviews: ReviewPage;
}

const NO_REVIEWS: ReviewPage = { reviews: [], next: null };

/**
 * The profile page: the seller header and the cards of the published listings, or null (404).
 * Throws once Firestore reads are degraded, like getPublishedBySlugId (only the ISR profile page
 * calls it).
 */
export async function getPublicProfile(publicId: string, limit = 24): Promise<PublicProfileView | null> {
  await assertQuotas(PUBLIC_READ_QUOTAS);
  const user = await findUserByPublicId(publicId);
  if (!user || !isVisibleAccount(user)) return null;
  if (user.status === "suspended") return { ...toSeller(user, 0), listings: [], reviews: NO_REVIEWS };
  return profileView(user, limit);
}

async function profileView(user: UserRecord, limit: number): Promise<PublicProfileView> {
  const [view, reviews] = await Promise.all([publishedView(user, limit), user.stats.ratingCount > 0 ? sellerReviews(user.uid, REVIEWS_PAGE) : NO_REVIEWS]);
  return { ...view, reviews };
}

async function publishedView(user: UserRecord, limit: number): Promise<Omit<PublicProfileView, "reviews">> {
  const fetched = await listPublishedByOwner(user.uid, limit);
  // Listings hidden by a report (D11) are not shown, nor counted when the page shows them all.
  const records = fetched.filter((listing) => !listing.moderation.hiddenBy);
  // A full page may hide more listings: count them; otherwise the page is the count.
  const count = fetched.length >= limit ? Math.max(records.length, (await countPublishedByOwner(user.uid)) - (fetched.length - records.length)) : records.length;
  const listings = records.map(toPublicCard).filter((card): card is PublicListingCard => card !== null);
  return { ...toSeller(user, count), listings };
}

export interface PublicStorefront {
  proId: string;
  /** URL segment "{slug}-{proId}" of /boutique. */
  segment: string;
  name: string;
  description: string;
  citySlug: string;
  /** "real_estate": an agency's storefront (Agence pack design §3). */
  sector: ProSector;
  /** The agency's fee schedule ("" when none). */
  feeSchedule: string;
  /** A car rental agency's settings (sector "car_rental", rental pack §5), null until saved. */
  rental: RentalAgency | null;
  /** ISO day the licence decision was checked on its document (decision 5), null while not checked. */
  rentalCheckedAt: string | null;
  /** « Payer chez le vendeur » and the seller information, when the shop has turned them on. */
  payment: PublicShopPayment | null;
  /** The owner's public face and listings, as on /profil. */
  seller: PublicProfileView;
  /** Example shop (src/lib/demo): labelled, never "vérifiée", not indexed. */
  example: boolean;
  /** Sections of the storefront (catalogue §5), in display order. */
  sections: ShopSection[];
}

/**
 * The storefront page of a Pro shop (phase 7 design §4), or null (404): unknown shop, or one whose
 * storefront is not shown (`storefrontShown`: verified, active or grace with a plan), or whose
 * owner has no public face or is suspended. The listings are the owner's published ones, as on
 * the profile page (a Pro account publishes as its shop only).
 */
export async function getPublicStorefront(proId: string, limit = 24): Promise<PublicStorefront | null> {
  await assertQuotas(PUBLIC_READ_QUOTAS);
  const profile = await getProProfile(proId);
  if (!profile || !storefrontShown(profile.lifecycle, profile.plan)) return null;
  const user = await getUserRecord(profile.ownerUid);
  if (!user || !isVisibleAccount(user) || user.status === "suspended") return null;
  const payment = profile.sellerPayment ? publicShopPayment(profile, await getSellerPayments(), new Date()) : null;
  return {
    payment,
    proId: profile.proId,
    segment: storefrontSegment(profile.slug, profile.proId),
    name: profile.name,
    description: profile.description,
    citySlug: profile.citySlug,
    sector: profile.sector ?? "general",
    feeSchedule: profile.sector === "real_estate" ? (profile.agency?.feeSchedule ?? "") : "",
    rental: profile.sector === "car_rental" ? (profile.rental ?? null) : null,
    rentalCheckedAt: profile.sector === "car_rental" ? checkedOn(profile) : null,
    seller: await profileView(user, limit),
    example: profile.example === true,
    sections: profile.sections ?? [],
  };
}

/** The day the licence check was passed, for the reference still in the settings. */
function checkedOn(profile: Pick<ProProfileRecord, "rental" | "rentalCheck">): string | null {
  const check = profile.rentalCheck;
  if (!check || check.status !== "verified" || !check.checkedAt || check.agrementRef !== profile.rental?.agrementRef) return null;
  return check.checkedAt.toISOString();
}

export function storefrontSegment(slug: string, proId: string): string {
  return `${slug}-${proId}`;
}

/** The proId of a /boutique segment "{slug}-{proId}", or null when it cannot be one. */
export function parseStorefrontSegment(segment: string): { slug: string; proId: string } | null {
  const cut = segment.lastIndexOf("-");
  if (cut <= 0) return null;
  const proId = segment.slice(cut + 1);
  return PRO_ID_PATTERN.test(proId) ? { slug: segment.slice(0, cut), proId } : null;
}

export function storefrontPath(locale: string, segment: string): string {
  return `/${locale}/boutique/${segment}`;
}
