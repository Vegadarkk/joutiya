import "server-only";
import type { Condition } from "@/config/categories";
import type { ListingAttributes, ListingStatus } from "@/lib/contracts/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import { getListing, listPublishedByOwner, type ListingRecord } from "@/lib/db/repositories/listings";
import { findUserByPublicId, getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
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
 * The listing behind a URL segment: null (404) when the id is malformed, the document missing, or
 * the listing never/no longer public (draft, pending_review, rejected, removed, purged).
 */
export async function getPublishedBySlugId(segment: string): Promise<PublicListingLookup | null> {
  // Ids are lower case: a segment retyped in capitals still finds its listing (then 301s).
  const parsed = parseSlugId(segment.toLowerCase());
  if (!parsed) return null;
  const listing = await getListing(parsed.id);
  if (!listing || !isPublicState(listing.status)) return null;
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

/** Accounts that have a public face: activated, neither closed nor banned (suspended: no listing). */
function isVisibleAccount(user: UserRecord): boolean {
  return user.status !== "closed" && user.status !== "banned" && user.activation === "done";
}

/** Public profile of a seller by publicId, or null (unknown id, closed or banned account). */
export async function getProfile(publicId: string, limit = 24): Promise<PublicProfile | null> {
  const user = await findUserByPublicId(publicId);
  if (!user || !isVisibleAccount(user)) return null;
  const listings = user.status === "suspended" ? [] : await listPublishedByOwner(user.uid, limit);
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
  /** ISO 8601. */
  publishedAt: string;
  sortAt: string;
  updatedAt: string;
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
}

function publicPhotos(record: ListingRecord): PublicPhoto[] {
  return record.photos.map(({ id, w, h, blurhash }) => ({ id, w, h, blurhash }));
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
    price: record.price,
    priceNegotiable: record.priceNegotiable,
    isDonation: record.isDonation,
    citySlug: record.location?.citySlug ?? null,
    photo: photos[0] ?? null,
    photoCount: photos.length,
    sellerType: record.sellerType,
    sortAt: record.sortAt.toISOString(),
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
  /** Listings online right now (count aggregation: one read). */
  publishedCount: number;
}

/**
 * Listings of a seller in `published` status: one aggregation read per 1 000 index entries (equality
 * filters only; the (ownerUid, status, sortAt) composite index serves it).
 */
export async function countPublishedByOwner(uid: string): Promise<number> {
  const result = await db().collection(COLLECTIONS.listings).where("ownerUid", "==", uid).where("status", "==", "published").count().get();
  void consume("firestore.reads", 1);
  return result.data().count;
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
}

/** The profile page: the seller header and the cards of the published listings, or null (404). */
export async function getPublicProfile(publicId: string, limit = 24): Promise<PublicProfileView | null> {
  const user = await findUserByPublicId(publicId);
  if (!user || !isVisibleAccount(user)) return null;
  if (user.status === "suspended") return { ...toSeller(user, 0), listings: [] };
  const records = await listPublishedByOwner(user.uid, limit);
  // A full page may hide more listings: count them; otherwise the page is the count.
  const count = records.length >= limit ? await countPublishedByOwner(user.uid) : records.length;
  const listings = records.map(toPublicCard).filter((card): card is PublicListingCard => card !== null);
  return { ...toSeller(user, count), listings };
}
