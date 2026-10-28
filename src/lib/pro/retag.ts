import "server-only";
import { listOwnerListingIds, type ListingRecord } from "@/lib/db/repositories/listings";
import { applyListingTransition, type TransitionWrite } from "@/lib/db/repositories/retention";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { notifySearchIndex } from "@/lib/search/queue";

// Lifecycle effect `retagListings` (src/lib/pro/lifecycle.ts): when an account becomes Pro, its
// existing listings carry `sellerType: "pro"` and the shop's `proId` (search filter, badge, public
// page). One transaction per listing through applyListingTransition (re-reads the listing, bumps
// the version, writes the searchOutbox entry of a published one). Idempotent: a listing already
// tagged is skipped, so a run cut short is completed by running it again.

export const RETAG_PAGE = 100;
/** An individual has at most 20 active listings; 1 000 covers its whole history with margin. */
export const RETAG_MAX_PAGES = 10;

export interface RetagResult {
  retagged: number;
  /** False when RETAG_MAX_PAGES stopped the run before the last listing. */
  complete: boolean;
}

/** The patch that tags `current` for `proId` (null: back to an individual's listing), or null when already tagged. */
export function retagWrite(current: Pick<ListingRecord, "ownerUid" | "sellerType" | "proId" | "status" | "version">, uid: string, proId: string | null): TransitionWrite | null {
  if (current.ownerUid !== uid) return null;
  const sellerType = proId ? "pro" : "individual";
  if (current.sellerType === sellerType && (current.proId ?? null) === proId) return null;
  return { patch: { sellerType, proId, version: current.version + 1 }, search: current.status === "published" ? "upsert" : null };
}

export async function retagOwnerListings(uid: string, proId: string | null, now = new Date()): Promise<RetagResult> {
  let retagged = 0;
  let after: string | undefined;
  for (let page = 0; page < RETAG_MAX_PAGES; page += 1) {
    const ids = await listOwnerListingIds(uid, RETAG_PAGE, after);
    const published: string[] = [];
    for (const id of ids) {
      const updated = await applyListingTransition(id, (current) => retagWrite(current, uid, proId), now);
      if (!updated) continue;
      retagged += 1;
      if (updated.status === "published") {
        published.push(id);
        if (updated.slugId) revalidateListingPaths({ slugId: updated.slugId });
      }
    }
    await notifySearchIndex(published);
    if (ids.length < RETAG_PAGE) return { retagged, complete: true };
    after = ids[ids.length - 1];
  }
  logger.warn({ uid, retagged }, "retag stopped at RETAG_MAX_PAGES; run it again to finish");
  return { retagged, complete: false };
}
