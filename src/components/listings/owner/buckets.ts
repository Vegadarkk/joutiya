import type { ListingStatus, OwnerListBucket, OwnerListingSummary } from "@/lib/contracts/listings";

// Pure helpers of "Mes annonces" (unit-tested): which statuses a tab shows, the one action a row
// puts forward, and the tab keyboard model (WAI-ARIA tabs, automatic activation, RTL aware).

/**
 * Statuses each tab shows. Mirrors the server buckets (OWNER_BUCKET_STATUSES) minus `removed`:
 * a listing the owner deleted does not come back under "Terminées".
 */
export const BUCKET_STATUSES: Record<OwnerListBucket, readonly ListingStatus[]> = {
  drafts: ["draft"],
  active: ["published", "paused"],
  pending: ["pending_review"],
  ended: ["sold", "expired", "rejected"],
};

/** The rows a tab shows: the server answer without deleted listings, most recent change first. */
export function visibleListings(bucket: OwnerListBucket, listings: readonly OwnerListingSummary[]): OwnerListingSummary[] {
  const statuses = BUCKET_STATUSES[bucket];
  return listings.filter((listing) => statuses.includes(listing.status)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export type PrimaryAction = { kind: "continue" } | { kind: "fix" } | { kind: "resume" } | { kind: "renew" };

/**
 * A paused listing resumes only before its expiry (lifecycle: the server answers 409 after it, even
 * while the nightly expire job has not turned it `expired` yet; renewal then takes over).
 */
export function canResume(listing: Pick<OwnerListingSummary, "status" | "expiresAt">, now = new Date()): boolean {
  return listing.status === "paused" && listing.expiresAt !== null && Date.parse(listing.expiresAt) > now.getTime();
}

/** The action a row shows as a button (the others stay in its menu); null when none stands out. */
export function primaryAction(listing: OwnerListingSummary, now = new Date()): PrimaryAction | null {
  switch (listing.status) {
    case "draft":
      return { kind: "continue" };
    case "rejected":
      return { kind: "fix" };
    case "paused":
      return canResume(listing, now) ? { kind: "resume" } : null;
    case "published":
    case "expired":
      return listing.canRenew ? { kind: "renew" } : null;
    default:
      return null;
  }
}

/** Index of the tab a key moves to (arrows follow the reading direction), or null for other keys. */
export function tabKeyTarget(key: string, index: number, count: number, rtl: boolean): number | null {
  if (count <= 0) return null;
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  if (key === forward) return (index + 1) % count;
  if (key === backward) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
