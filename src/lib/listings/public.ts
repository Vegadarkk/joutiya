import "server-only";
import type { ListingStatus } from "@/lib/contracts/listings";
import { getListing, listPublishedByOwner, type ListingRecord } from "@/lib/db/repositories/listings";
import { findUserByPublicId, type UserRecord } from "@/lib/db/repositories/profiles";
import { buildSlugId, parseSlugId } from "./ids";

// Public reads (design §4 public.ts): the listing page by its `{slug}-{id}` segment and the
// seller's profile by publicId. No uid leaves these functions' return values except inside the
// records the page renders server-side (never serialized to the client as such).

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
  const parsed = parseSlugId(segment);
  if (!parsed) return null;
  const listing = await getListing(parsed.id);
  if (!listing || !isPublicState(listing.status)) return null;
  const canonicalSlugId = listing.slugId ?? buildSlugId({ id: listing.id, title: listing.title, categoryId: listing.categoryId });
  return { listing, canonicalSlugId, redirect: segment !== canonicalSlugId, state: listing.status };
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

/** Public profile of a seller by publicId, or null (unknown id, closed or banned account). */
export async function getProfile(publicId: string, limit = 24): Promise<PublicProfile | null> {
  const user = await findUserByPublicId(publicId);
  if (!user || user.status === "closed" || user.status === "banned" || user.activation !== "done") return null;
  const listings = user.status === "suspended" ? [] : await listPublishedByOwner(user.uid, limit);
  return { publicId: user.publicId, displayName: user.displayName, memberSince: memberSince(user.createdAt), badges: user.badges, sellerType: user.type, listings };
}

export { listPublishedByOwner };
