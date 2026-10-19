import { alert } from "@/lib/alert";
import { audit } from "@/lib/audit";
import { PHOTO_VARIANTS } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { deleteJournalPastPurge, listListingsPastPurge, oldestPastPurge, purgeListing, type JournalCollection, type ListingCursor } from "@/lib/db/repositories/retention";
import { deleteUploadDocument, listUploadsByTarget, updateUpload, UPLOADS_BY_TARGET_LIMIT, type UploadRecord } from "@/lib/db/repositories/uploads";
import { COLLECTIONS, type ListingStatus } from "@/lib/db/schemas";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { photoObjectKey, quarantineObjectKey, type PhotoBucket } from "@/lib/media/urls";
import { isDegraded } from "@/lib/quota";
import { notifySearchIndex } from "@/lib/search/queue";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { RETAINED_STATUSES, storedBytes } from "@/lib/uploads/policy";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";

// Nightly at 03:00 UTC (architecture §5 "Purges sans TTL", table of §7 retention, design D16):
// 1. listings past purgeAt (expired, sold, removed or rejected + listingPurgeMonths, or a draft
//    30 days after its last edit, A4-04) without a legal hold: replaced by a tombstone (transaction re-checking status, hold and date, with the
//    searchOutbox delete), then their photo variants, quarantine objects and upload documents go.
//    A removed listing keeps its text and its photos until then (architecture §5: removal + 12
//    months): purge-quarantine (hourly) moves its photos to the private bucket
//    (`removed/listings/...`) and the purgeAt of its uploads to the listing's, and never deletes
//    them; a removed listing's variants are deleted from both buckets (a move cut short can leave
//    them in either). Unattached and orphan uploads of other listings are purge-quarantine's;
// 2. contentOps (1 year) and revealLogs (90 days) past purgeAt.
// At most PURGE_DELETE_BUDGET document deletions a night (Spark: 20 000 a day); the rest waits a
// night, and a backlog older than 3 days raises an alert. Idempotent: every step re-reads.

export const PURGE_DELETE_BUDGET = 15_000;
export const LISTING_PURGE_BATCH = 100;
export const LISTING_PURGE_PAGES = 20;
/** Pages of upload documents read for one purged listing (each page is deleted before the next query). */
export const LISTING_MEDIA_PAGES = 5;
export const JOURNAL_BATCH = 400;
export const BACKLOG_ALERT_MS = 3 * 24 * 3_600_000;

/** Statuses whose purgeAt ends the listing; published, paused and pending listings are never purged. */
export const PURGEABLE_STATUSES: readonly ListingStatus[] = ["expired", "sold", "removed", "rejected", "draft"];

export interface RetentionResult {
  /** Listings replaced by a tombstone. */
  listings: number;
  /** Past purgeAt but under a legal hold. */
  held: number;
  /** Past purgeAt but not purgeable (status, or changed since the query), or unreadable. */
  skipped: number;
  /** Upload documents deleted (with their objects). */
  uploads: number;
  /** Storage objects deleted (idempotent: a missing object counts too). */
  objects: number;
  contentOps: number;
  revealLogs: number;
  failed: number;
  /** The delete budget or the Firestore quota stopped the run before the end. */
  deferred: boolean;
}

interface RunState {
  now: Date;
  store: ObjectStore | null;
  budget: number;
  freedBytes: number;
  /** Steps that failed, with their error: one alert per run. */
  failedSteps: string[];
  result: RetentionResult;
}

export function isPurgeable(listing: Pick<ListingRecord, "status" | "legalHold" | "purgeAt">, now: Date): boolean {
  return PURGEABLE_STATUSES.includes(listing.status) && listing.legalHold.length === 0 && listing.purgeAt !== undefined && listing.purgeAt.getTime() <= now.getTime();
}

/** Buckets that may hold a photo of `listing`: the private one too for a removed listing's, or an upload recorded there. */
function photoBuckets(listing: Pick<ListingRecord, "status">, upload?: Pick<UploadRecord, "bucket">): PhotoBucket[] {
  return RETAINED_STATUSES.includes(listing.status) || upload?.bucket === "private" ? ["media", "private"] : ["media"];
}

async function deleteVariants(store: ObjectStore, listingId: string, photoId: string, buckets: readonly PhotoBucket[], state: RunState): Promise<void> {
  for (const bucket of buckets) {
    for (const variant of PHOTO_VARIANTS) {
      await store.delete(bucket, photoObjectKey(bucket, listingId, photoId, variant));
      state.result.objects += 1;
    }
  }
}

/** Objects first, then the document: a storage failure leaves the document to retry from. */
async function deleteUpload(store: ObjectStore, listing: ListingRecord, upload: UploadRecord, state: RunState): Promise<void> {
  await deleteVariants(store, upload.targetId, upload.id, photoBuckets(listing, upload), state);
  await store.delete("quarantine", upload.quarantineKey);
  state.result.objects += 1;
  // By the document as this run removed it: an owner DELETE or purge-quarantine may have ended or
  // removed it since the listing, and then its bytes were theirs (no delete either: none counted).
  const removed = await deleteUploadDocument(upload.id);
  state.freedBytes += storedBytes(removed);
  if (!removed) return;
  state.result.uploads += 1;
  state.budget -= 1;
}

/**
 * Media of a purged listing: every upload document of it (page after page, each deleted before the
 * next query), and any attached photo without one.
 */
async function purgeListingMedia(store: ObjectStore, listing: ListingRecord, state: RunState): Promise<void> {
  const known = new Set<string>();
  for (let pages = 0; pages < LISTING_MEDIA_PAGES; pages += 1) {
    const uploads = await listUploadsByTarget(listing.id);
    try {
      for (const upload of uploads) {
        known.add(upload.id);
        await deleteUpload(store, listing, upload, state);
      }
    } catch (error) {
      // The listing is a tombstone now: hand what is left to purge-quarantine (orphan uploads past purgeAt).
      await Promise.allSettled(uploads.map((upload) => updateUpload(upload.id, { purgeAt: state.now }, state.now)));
      throw error;
    }
    if (uploads.length < UPLOADS_BY_TARGET_LIMIT) break;
  }
  // A photo id is its upload id: without the document, its keys are still derivable.
  for (const photo of listing.photos) {
    if (known.has(photo.id)) continue;
    await deleteVariants(store, listing.id, photo.id, photoBuckets(listing), state);
    await store.delete("quarantine", quarantineObjectKey(photo.id));
    state.result.objects += 1;
  }
}

async function purgeListings(state: RunState): Promise<void> {
  const { now, result } = state;
  let cursor: ListingCursor | undefined;
  for (let pages = 0; pages < LISTING_PURGE_PAGES; pages += 1) {
    const page = await listListingsPastPurge(now, LISTING_PURGE_BATCH, cursor);
    result.skipped += page.read - page.listings.length;
    for (const listing of page.listings) {
      if (listing.legalHold.length > 0) {
        result.held += 1;
        continue;
      }
      if (!isPurgeable(listing, now)) {
        result.skipped += 1;
        continue;
      }
      if (state.budget <= 0) {
        result.deferred = true;
        return;
      }
      try {
        const tombstone = await purgeListing(listing.id, (current) => isPurgeable(current, now), now);
        if (!tombstone) {
          result.skipped += 1;
          continue;
        }
        result.listings += 1;
        await notifySearchIndex([listing.id]);
        await audit({ actorUid: "system", actorRole: "system", action: "listing.purge", target: { type: "listing", id: listing.id }, automated: true, at: now });
        if (state.store) await purgeListingMedia(state.store, listing, state);
      } catch (error) {
        result.failed += 1;
        logger.warn({ listingId: listing.id, err: (error as Error).message }, "listing not purged");
      }
    }
    if (!page.next || page.read < LISTING_PURGE_BATCH) return;
    cursor = page.next;
  }
}

async function purgeJournal(collection: JournalCollection, key: "contentOps" | "revealLogs", state: RunState): Promise<void> {
  while (state.budget > 0) {
    const wanted = Math.min(JOURNAL_BATCH, state.budget);
    const deleted = await deleteJournalPastPurge(collection, state.now, wanted);
    state.result[key] += deleted;
    state.budget -= deleted;
    if (deleted < wanted) return;
  }
  state.result.deferred = true;
  const oldest = await oldestPastPurge(collection, state.now);
  if (oldest && state.now.getTime() - oldest.getTime() > BACKLOG_ALERT_MS) {
    await alert({
      severity: "P2",
      title: `Purge en retard : ${collection}`,
      body: `Des documents ${collection} attendent leur suppression depuis le ${oldest.toISOString().slice(0, 10)} (budget de ${PURGE_DELETE_BUDGET} suppressions par nuit atteint).`,
    });
  }
}

export async function retentionPurge(now = new Date(), deps: { store?: ObjectStore } = {}): Promise<RetentionResult> {
  const result: RetentionResult = { listings: 0, held: 0, skipped: 0, uploads: 0, objects: 0, contentOps: 0, revealLogs: 0, failed: 0, deferred: false };
  if (!isFirestoreConfigured()) {
    logger.warn("retention-purge skipped: Firebase not configured");
    return result;
  }
  let store: ObjectStore | null;
  try {
    store = deps.store ?? objectStore();
  } catch (error) {
    if (!isStorageNotConfigured(error)) throw error;
    store = null;
  }
  const state: RunState = { now, store, budget: PURGE_DELETE_BUDGET, freedBytes: 0, failedSteps: [], result };

  // Without object storage the photos could not be deleted: listings and uploads wait (no orphan objects).
  if (store) {
    await step("listings", state, () => purgeListings(state));
  } else {
    logger.warn("retention-purge: object storage not configured, listings and their uploads left for a later run");
  }
  await step("contentOps", state, () => purgeJournal(COLLECTIONS.contentOps, "contentOps", state));
  await step("revealLogs", state, () => purgeJournal(COLLECTIONS.revealLogs, "revealLogs", state));
  // The job completes anyway, so the worker's failed handler never hears of a failed step.
  if (state.failedSteps.length > 0) {
    await alert({
      severity: "P2",
      title: "Tâche système en échec : retention-purge",
      body: `Étape(s) en échec : ${state.failedSteps.join(" ; ")}. La nuit suivante réessaie.`,
    });
  }

  if (state.freedBytes > 0) await recordMediaBytes(-state.freedBytes, now);
  logger.info({ ...result }, "retention-purge");
  return result;
}

/** One step; a failing query stops that step only, never the others. The delete quota is re-checked before each. */
async function step(name: string, state: RunState, run: () => Promise<void>): Promise<void> {
  try {
    if (await isDegraded("firestore.deletes")) {
      state.result.deferred = true;
      logger.warn({ step: name }, "retention-purge: step deferred, Firestore delete quota degraded");
      return;
    }
    await run();
  } catch (error) {
    state.result.failed += 1;
    state.failedSteps.push(`${name} (${(error as Error).message.slice(0, 200)})`);
    logger.error({ step: name, err: (error as Error).message }, "retention-purge step failed");
  }
}
