import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { isDegraded } from "@/lib/quota";
import { expireBoost, listBoostsEndedBetween, readBoostSweepCursor, writeBoostSweepCursor, type BoostCursor } from "@/lib/search/boosts";
import { notifySearchIndex } from "@/lib/search/queue";

// Nightly at 04:05 UTC (design D8): safety net of the delayed `expire-boost` jobs. Published
// listings whose À la Une ended since the last sweep get a searchOutbox entry (re-index without the
// stale date), then the ids go to the search queue; the outbox poll catches what that misses.
// Bounded per night: a cut run resumes from the last end date it reached, a failed listing from
// its own end date (an entry written twice is harmless).

export const BOOST_SWEEP_BATCH = 200;
export const BOOST_SWEEP_PAGES = 10;
/** First run (no cursor): how far back ended boosts are looked for. */
export const BOOST_SWEEP_LOOKBACK_MS = 7 * 24 * 3_600_000;

export interface BoostSweepResult {
  /** Entries written. */
  expired: number;
  /** Extended or unpublished since the query: left alone. */
  skipped: number;
  failed: number;
  /** The page budget ran out before `now`. */
  partial: boolean;
}

export async function sweepExpiredBoosts(now: Date = new Date()): Promise<BoostSweepResult> {
  const result: BoostSweepResult = { expired: 0, skipped: 0, failed: 0, partial: false };
  if (!isFirestoreConfigured()) {
    logger.warn("expire-boosts skipped: Firebase not configured");
    return result;
  }
  if (await isDegraded("firestore.writes")) {
    logger.warn("expire-boosts deferred: Firestore write quota degraded");
    return result;
  }
  const from = (await readBoostSweepCursor()) ?? new Date(now.getTime() - BOOST_SWEEP_LOOKBACK_MS);
  let cursor: BoostCursor | undefined;
  let through = now;
  let retryFrom = now;
  for (let pages = 0; ; pages += 1) {
    if (pages >= BOOST_SWEEP_PAGES) {
      result.partial = true;
      if (cursor) through = cursor.at;
      break;
    }
    const page = await listBoostsEndedBetween(from, now, BOOST_SWEEP_BATCH, cursor);
    const written: string[] = [];
    for (const [index, id] of page.ids.entries()) {
      try {
        if (await expireBoost(id, now)) written.push(id);
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        const end = page.ends[index];
        if (end && end < retryFrom) retryFrom = end;
        logger.warn({ listingId: id, err: (error as Error).message }, "boost expiry not written");
      }
    }
    result.expired += written.length;
    await notifySearchIndex(written);
    if (!page.next || page.read < BOOST_SWEEP_BATCH) break;
    cursor = page.next;
  }
  await writeBoostSweepCursor(retryFrom < through ? retryFrom : through, now);
  logger.info({ ...result }, "expire-boosts");
  return result;
}
