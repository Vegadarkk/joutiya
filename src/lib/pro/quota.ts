import "server-only";
import { listOwnerListingsByStatus, type ListingRecord } from "@/lib/db/repositories/listings";
import { changeListings, lifetime, SANCTION_LISTINGS_MAX } from "@/lib/decisions/sanctions";
import { transition } from "@/lib/listings/lifecycle";

// Lifecycle effect `pauseOverQuota` (src/lib/pro/lifecycle.ts): after a downgrade, an expiry or a
// switch to a smaller plan, the shop's active listings (published + held for review) are brought
// back within `activeListings`: the published ones with the oldest `sortAt` are paused
// (`pausedReason: "quota"`, out of search). They are not republished automatically when a plan
// comes back (spec §5 lifecycle): the owner resumes them from Mes annonces, within the quota.
// Idempotent: every subscription sync runs it.

const oldestFirst = (a: ListingRecord, b: ListingRecord) => a.sortAt.getTime() - b.sortAt.getTime();

/** `activeListings` null = unlimited. Answers the ids paused. */
export async function pauseListingsOverQuota(ownerUid: string, activeListings: number | null, now = new Date()): Promise<string[]> {
  if (activeListings === null) return [];
  const active = await listOwnerListingsByStatus(ownerUid, ["published", "pending_review"], SANCTION_LISTINGS_MAX);
  if (active.length <= activeListings) return [];
  const life = await lifetime();
  const excess = active.filter((listing) => listing.status === "published").sort(oldestFirst).slice(0, active.length - activeListings);
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
  return changes.map((change) => change.listing.id);
}
