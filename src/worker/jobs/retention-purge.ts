import { alert } from "@/lib/alert";
import { audit } from "@/lib/audit";
import { PHOTO_VARIANTS } from "@/lib/contracts/media";
import { getListings, type ListingRecord } from "@/lib/db/repositories/listings";
import { deleteJournalPastPurge, listListingsPastPurge, oldestPastPurge, purgeListing, type JournalCollection, type ListingCursor } from "@/lib/db/repositories/retention";
import { deleteUploadDocument, listPastPurge, listUploadsByTarget, updateUpload, type PurgeCursor, type UploadRecord } from "@/lib/db/repositories/uploads";
import { COLLECTIONS, type ListingStatus } from "@/lib/db/schemas";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { mediaObjectKey, quarantineObjectKey } from "@/lib/media/urls";
import { isDegraded } from "@/lib/quota";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";

// Nightly at 03:00 UTC (architecture §5 "Purges sans TTL", table of §7 retention, design D16):
// 1. listings past purgeAt (expired, sold, removed or rejected + listingPurgeMonths) without a
//    legal hold: replaced by a tombstone (transaction re-checking status, hold and date, with the
//    searchOutbox delete), then their photo variants, quarantine objects and upload documents go;
// 2. uploads past purgeAt of removed listings (service.ts sets purgeAt = now at removal): variants
//    and quarantine object deleted, then the document. Unattached and orphan uploads belong to
//    purge-quarantine (hourly), which leaves removed listings to this job;
// 3. contentOps (1 year) and revealLogs (90 days) past purgeAt.
// At most PURGE_DELETE_BUDGET document deletions a night (Spark: 20 000 a day); the rest waits a
// night, and a backlog older than 3 days raises an alert. Idempotent: every step re-reads.

export const PURGE_DELETE_BUDGET = 15_000;
export const LISTING_PURGE_BATCH = 100;
export const LISTING_PURGE_PAGES = 20;
export const UPLOAD_PURGE_BATCH = 200;
export const UPLOAD_PURGE_PAGES = 10;
export const JOURNAL_BATCH = 400;
export const BACKLOG_ALERT_MS = 3 * 24 * 3_600_000;

/** Statuses whose purgeAt ends the listing; published, paused and pending listings are never purged. */
export const PURGEABLE_STATUSES: readonly ListingStatus[] = ["expired", "sold", "removed", "rejected"];

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
  result: RetentionResult;
}

export function isPurgeable(listing: Pick<ListingRecord, "status" | "legalHold" | "purgeAt">, now: Date): boolean {
  return PURGEABLE_STATUSES.includes(listing.status) && listing.legalHold.length === 0 && listing.purgeAt !== undefined && listing.purgeAt.getTime() <= now.getTime();
}

async function deleteVariants(store: ObjectStore, listingId: string, photoId: string, state: RunState): Promise<void> {
  for (const variant of PHOTO_VARIANTS) {
    await store.delete("media", mediaObjectKey(listingId, photoId, variant));
    state.result.objects += 1;
  }
}

/** Objects first, then the document: a storage failure leaves the document to retry from. */
async function deleteUpload(store: ObjectStore, upload: UploadRecord, state: RunState): Promise<void> {
  await deleteVariants(store, upload.targetId, upload.id, state);
  await store.delete("quarantine", upload.quarantineKey);
  state.result.objects += 1;
  await deleteUploadDocument(upload.id);
  state.result.uploads += 1;
  state.budget -= 1;
  if (upload.status === "ready" && upload.size) state.freedBytes += upload.size;
}

/** Media of a purged listing: every upload document of it, and any attached photo without one. */
async function purgeListingMedia(store: ObjectStore, listing: ListingRecord, state: RunState): Promise<void> {
  const uploads = await listUploadsByTarget(listing.id);
  try {
    const known = new Set(uploads.map((upload) => upload.id));
    // A photo id is its upload id: without the document, its keys are still derivable.
    for (const photo of listing.photos) {
      if (known.has(photo.id)) continue;
      await deleteVariants(store, listing.id, photo.id, state);
      await store.delete("quarantine", quarantineObjectKey(photo.id));
      state.result.objects += 1;
    }
    for (const upload of uploads) await deleteUpload(store, upload, state);
  } catch (error) {
    // The listing is a tombstone now: hand what is left to purge-quarantine (orphan uploads past purgeAt).
    await Promise.allSettled(uploads.map((upload) => updateUpload(upload.id, { purgeAt: state.now }, state.now)));
    throw error;
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

async function purgeRemovedUploads(store: ObjectStore, state: RunState): Promise<void> {
  const { now, result } = state;
  let cursor: PurgeCursor | undefined;
  for (let pages = 0; pages < UPLOAD_PURGE_PAGES; pages += 1) {
    const uploads = await listPastPurge(now, UPLOAD_PURGE_BATCH, cursor);
    if (uploads.length === 0) return;
    const listings = new Map((await getListings([...new Set(uploads.map((upload) => upload.targetId))])).map((listing) => [listing.id, listing]));
    for (const upload of uploads) {
      const listing = listings.get(upload.targetId);
      if (!listing || listing.status !== "removed" || listing.legalHold.length > 0) continue;
      if (state.budget <= 0) {
        result.deferred = true;
        return;
      }
      try {
        await deleteUpload(store, upload, state);
      } catch (error) {
        result.failed += 1;
        logger.warn({ uploadId: upload.id, err: (error as Error).message }, "upload of a removed listing not purged");
      }
    }
    const last = uploads[uploads.length - 1]!;
    cursor = { purgeAt: last.purgeAt, id: last.id };
    if (uploads.length < UPLOAD_PURGE_BATCH) return;
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
  const state: RunState = { now, store, budget: PURGE_DELETE_BUDGET, freedBytes: 0, result };

  // Without object storage the photos could not be deleted: listings and uploads wait (no orphan objects).
  if (store) {
    await step("listings", state, () => purgeListings(state));
    await step("uploads", state, () => purgeRemovedUploads(store, state));
  } else {
    logger.warn("retention-purge: object storage not configured, listings and uploads left for a later run");
  }
  await step("contentOps", state, () => purgeJournal(COLLECTIONS.contentOps, "contentOps", state));
  await step("revealLogs", state, () => purgeJournal(COLLECTIONS.revealLogs, "revealLogs", state));

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
    logger.error({ step: name, err: (error as Error).message }, "retention-purge step failed");
  }
}
