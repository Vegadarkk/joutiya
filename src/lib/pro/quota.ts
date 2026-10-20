import "server-only";
import { listOwnerListingsByStatus, type ListingRecord } from "@/lib/db/repositories/listings";
import { changeListings, lifetime, SANCTION_LISTINGS_MAX } from "@/lib/decisions/sanctions";
import { transition } from "@/lib/listings/lifecycle";
import { adsEligibleOf } from "@/lib/reports";

// Lifecycle effect `pauseOverQuota` (src/lib/pro/lifecycle.ts) and its reverse: after a plan
// change, a downgrade or a renewal, the shop's active listings (published + held for review) are
// brought back within `activeListings`. Over it, the published ones with the oldest `sortAt` are
// paused (`pausedReason: "quota"`, out of search); under it, listings paused for quota come back,
// newest first, published if not expired. Idempotent: every subscription sync runs it.

export interface QuotaAlignment {
  paused: string[];
  resumed: string[];
}

const bySortAt = (direction: 1 | -1) => (a: ListingRecord, b: ListingRecord) => direction * (a.sortAt.getTime() - b.sortAt.getTime());

/** `activeListings` null = unlimited. */
export async function alignListingsWithQuota(ownerUid: string, activeListings: number | null, now = new Date()): Promise<QuotaAlignment> {
  const life = await lifetime();
  const active = await listOwnerListingsByStatus(ownerUid, ["published", "pending_review"], SANCTION_LISTINGS_MAX);
  if (activeListings !== null && active.length > activeListings) {
    const excess = active.filter((listing) => listing.status === "published").sort(bySortAt(1)).slice(0, active.length - activeListings);
    const changes = await changeListings(
      excess,
      (listing) => {
        if (listing.status !== "published") return null;
        const { patch } = transition(listing, "paused", { now, lifetime: life, pausedReason: "quota" });
        return { patch: { ...patch, adsEligible: false }, search: "delete" };
      },
      now,
      "quota pause",
    );
    return { paused: changes.map((change) => change.listing.id), resumed: [] };
  }

  const room = activeListings === null ? Number.POSITIVE_INFINITY : activeListings - active.length;
  if (room <= 0) return { paused: [], resumed: [] };
  const paused = (await listOwnerListingsByStatus(ownerUid, ["paused"], SANCTION_LISTINGS_MAX)).filter((listing) => listing.pausedReason === "quota").sort(bySortAt(-1));
  // Only a listing coming back published takes a place; an expired one waits for its renewal.
  let places = room;
  const comeBack = paused.filter((listing) => {
    const live = listing.expiresAt !== undefined && listing.expiresAt.getTime() > now.getTime();
    if (!live) return true;
    if (places <= 0) return false;
    places -= 1;
    return true;
  });
  const changes = await changeListings(
    comeBack,
    (listing) => {
      if (listing.status !== "paused" || listing.pausedReason !== "quota") return null;
      const live = listing.expiresAt !== undefined && listing.expiresAt.getTime() > now.getTime();
      const { patch } = transition(listing, live ? "published" : "expired", { now, lifetime: life });
      return { patch: { ...patch, pausedReason: null, adsEligible: live && adsEligibleOf({ status: "published", moderation: listing.moderation }) }, search: live ? "upsert" : null };
    },
    now,
    "quota resume",
  );
  return { paused: [], resumed: changes.map((change) => change.listing.id) };
}
