import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { getListingTx } from "@/lib/db/repositories/listings";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { LISTING_ID_PATTERN, isListingId } from "@/lib/listings/ids";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { z } from "@/lib/zod";
import { ENQUEUE_TIMEOUT_MS, EXPIRE_BOOST_JOB, isSearchQueueEnabled, searchQueue, withTimeout } from "./queue";

// End of an À la Une period (design D8). The main sort never reads featuredUntil and the À la Une
// query filters `featuredUntil > now`, so an ended boost leaves the slots on time anyway; the
// re-index clears the stale date from the document. Two paths write the searchOutbox entry: a
// delayed `expire-boost` job per sale (phase 7 calls scheduleBoostExpiry), and the nightly
// expire-boosts sweep (04:05 UTC) over the boosts ended since the last sweep, as the safety net.

export const boostJobSchema = z.object({ id: z.string().regex(LISTING_ID_PATTERN), until: z.number().int().min(0) }).strict();
export type BoostJobData = z.infer<typeof boostJobSchema>;

/** The delayed job fires a little after the end, so `featuredUntil <= now` holds when it runs. */
const EXPIRY_GRACE_MS = 1_000;

export function boostJobId(listingId: string, until: Date): string {
  return `boost-${listingId}-${until.getTime()}`;
}

/**
 * Schedules the re-index of `listingId` when its À la Une ends (`until`). Best effort: returns
 * false without the queue (dev) or when Valkey fails; the nightly sweep catches it. Never throws.
 */
export async function scheduleBoostExpiry(listingId: string, until: Date, now: Date = new Date()): Promise<boolean> {
  if (!isListingId(listingId) || Number.isNaN(until.getTime())) return false;
  try {
    if (!isSearchQueueEnabled()) {
      logger.info({ listingId }, "boost expiry not scheduled: no queue (the nightly sweep covers it)");
      return false;
    }
    const data: BoostJobData = { id: listingId, until: until.getTime() };
    const delay = Math.max(0, until.getTime() - now.getTime()) + EXPIRY_GRACE_MS;
    const opts = { jobId: boostJobId(listingId, until), delay, attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: true, removeOnFail: true };
    await withTimeout(searchQueue().add(EXPIRE_BOOST_JOB, data, opts), ENQUEUE_TIMEOUT_MS, "boost expiry not scheduled in time");
    return true;
  } catch (error) {
    logger.warn({ listingId, err: (error as Error).message }, "boost expiry not scheduled: the nightly sweep covers it");
    return false;
  }
}

/**
 * Writes the searchOutbox entry of an ended À la Une (current listing version: nothing changes on
 * the listing). Skipped when the listing is gone or not published (not indexed), or when the
 * period was extended since (a later job owns it). Returns true when an entry was written.
 */
export async function expireBoost(listingId: string, now: Date = new Date()): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, listingId);
    if (!listing || listing.status !== "published") return false;
    const until = listing.boosts.featuredUntil;
    if (until && until.getTime() > now.getTime()) return false;
    enqueueSearchOutboxTx(tx, listingId, "upsert", listing.version, now);
    return true;
  });
}

// ---- Sweep query and cursor -------------------------------------------------------------------

export interface BoostCursor {
  at: Date;
  id: string;
}

export interface BoostPage {
  ids: string[];
  /** End date of each id (same order). */
  ends: Date[];
  read: number;
  next?: BoostCursor;
}

const FEATURED_UNTIL = "boosts.featuredUntil";

/** Published listings whose À la Une ended in [from, to], oldest end first (index status, boosts.featuredUntil). */
export async function listBoostsEndedBetween(from: Date, to: Date, limit: number, cursor?: BoostCursor): Promise<BoostPage> {
  let query = db()
    .collection(COLLECTIONS.listings)
    .where("status", "==", "published")
    .where(FEATURED_UNTIL, ">=", Timestamp.fromDate(from))
    .where(FEATURED_UNTIL, "<=", Timestamp.fromDate(to))
    .orderBy(FEATURED_UNTIL, "asc")
    .orderBy(FieldPath.documentId(), "asc");
  if (cursor) query = query.startAfter(Timestamp.fromDate(cursor.at), cursor.id);
  const snapshot = await query.select(FEATURED_UNTIL).limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const ids: string[] = [];
  const ends: Date[] = [];
  for (const doc of snapshot.docs) {
    const at: unknown = doc.get(FEATURED_UNTIL);
    if (!(at instanceof Timestamp)) continue;
    ids.push(doc.id);
    ends.push(at.toDate());
  }
  const lastId = ids[ids.length - 1];
  const lastEnd = ends[ends.length - 1];
  return { ids, ends, read: snapshot.size, ...(lastId && lastEnd ? { next: { at: lastEnd, id: lastId } } : {}) };
}

const SWEEP_DOC = "searchBoosts";

/** End of the window the last sweep completed (boosts ended up to it were handled), or null. */
export async function readBoostSweepCursor(): Promise<Date | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(SWEEP_DOC).get();
  void consume("firestore.reads", 1);
  const through: unknown = snapshot.get("through");
  return through instanceof Timestamp ? through.toDate() : null;
}

export async function writeBoostSweepCursor(through: Date, now: Date = new Date()): Promise<void> {
  await db().collection(COLLECTIONS.system).doc(SWEEP_DOC).set({ through: Timestamp.fromDate(through), updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
}
