import { PHOTO_VARIANTS } from "@/lib/contracts/media";
import { getListings, type ListingRecord } from "@/lib/db/repositories/listings";
import {
  deleteUploadDocument,
  listExpiredQuarantine,
  listPastPurge,
  listRejectedCreatedBetween,
  readRejectedSweepCursor,
  transitionUpload,
  updateUpload,
  writeRejectedSweepCursor,
  type PurgeCursor,
  type UploadRecord,
} from "@/lib/db/repositories/uploads";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { mediaObjectKey } from "@/lib/media/urls";
import { isDegraded } from "@/lib/quota";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { RETAINED_STATUSES } from "@/lib/uploads/policy";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";

// Hourly at :20 (design §4, architecture §6 "Les objets non traités sont purgés après 24 h"):
// 1. uploads still `signed` or `processing` 24 h after signing: upload `rejected` with reason
//    `expired`, then its quarantine object (and any variant) deleted;
// 2. `rejected` uploads: their quarantine object deleted once no presigned PUT can land any more
//    (the pipeline deletes it at once; this catches failed deletions and a PUT sent after
//    complete), swept in creation order behind a cursor (system/purgeQuarantine);
// 3. documents past purgeAt (7 days) not attached to a listing: objects and document deleted. An
//    attached photo lives with its listing: its purgeAt moves 30 days on. The uploads of a removed
//    listing are retention-purge's (deleted with the listing at its purgeAt, removal + 12 months):
//    their purgeAt moves to the listing's. A legal hold keeps everything, rechecked daily. A
//    purged listing (tombstone) does not read as a listing: its uploads are orphans, deleted.
//    Every skipped upload gets a later purgeAt, so no run reads it again before then.
// Steps 2 and 3 never mark anything before its objects go: a storage failure leaves the upload
// for the next run.

export const QUARANTINE_TTL_MS = 24 * 3_600_000;
/** Presigned URLs live 5 minutes: an hour after signing nothing can land in quarantine. */
export const REJECTED_SWEEP_DELAY_MS = 3_600_000;
/** First sweep (no cursor yet): back to the oldest upload that can still exist. */
export const REJECTED_SWEEP_LOOKBACK_MS = 8 * 24 * 3_600_000;
export const ATTACHED_RECHECK_MS = 30 * 24 * 3_600_000;
/** Uploads of a listing under a legal hold: looked at again a day later (a lifted hold is caught within a day). */
export const HOLD_RECHECK_MS = 24 * 3_600_000;
/** Uploads of a removed listing past its purgeAt (retention-purge runs nightly): looked at again a day later. */
export const RETAINED_RECHECK_MS = 24 * 3_600_000;
export const PURGE_QUARANTINE_BATCH = 200;
export const PURGE_PAGES = 5;

export interface PurgeQuarantineResult {
  /** Stale signed/processing uploads expired (step 1). */
  expired: number;
  /** Rejected uploads whose quarantine object was deleted (step 2). */
  swept: number;
  /** Unattached documents deleted with their objects (step 3). */
  purged: number;
  /** Attached photos whose purgeAt moved on (step 3). */
  extended: number;
  /** Past purgeAt but left alone (purgeAt moved on): legal hold, or removed listing (retention-purge). */
  skipped: number;
  failed: number;
}

const variantKeys = (upload: Pick<UploadRecord, "id" | "targetId">) => PHOTO_VARIANTS.map((variant) => mediaObjectKey(upload.targetId, upload.id, variant));

async function deleteObjects(store: ObjectStore, upload: UploadRecord, variants: boolean): Promise<void> {
  await store.delete("quarantine", upload.quarantineKey);
  if (variants) for (const key of variantKeys(upload)) await store.delete("media", key);
}

async function expireStale(store: ObjectStore, now: Date, result: PurgeQuarantineResult): Promise<void> {
  const stale = await listExpiredQuarantine(new Date(now.getTime() - QUARANTINE_TTL_MS), PURGE_QUARANTINE_BATCH);
  for (const upload of stale) {
    try {
      // Marked first: a run that finished meanwhile (a media backlog drained after an outage) keeps
      // its objects, and a run still going finds the upload rejected and removes what it stored.
      const marked = await transitionUpload(upload.id, ["signed", "processing"], { status: "rejected", rejectReason: "expired" }, now);
      if (!marked.ok) continue;
      result.expired += 1;
      // A processing run may have put variants before stalling. A failed deletion is retried by
      // the document purge (step 3) at purgeAt, and the quarantine lifecycle rule backs it up.
      await deleteObjects(store, upload, upload.status === "processing");
    } catch (error) {
      result.failed += 1;
      logger.warn({ uploadId: upload.id, err: (error as Error).message }, "stale upload not expired");
    }
  }
}

async function sweepRejected(store: ObjectStore, now: Date, result: PurgeQuarantineResult): Promise<void> {
  const after = (await readRejectedSweepCursor()) ?? new Date(now.getTime() - REJECTED_SWEEP_LOOKBACK_MS);
  const rejected = await listRejectedCreatedBetween(after, new Date(now.getTime() - REJECTED_SWEEP_DELAY_MS), PURGE_QUARANTINE_BATCH);
  let cursor: Date | null = null;
  for (const upload of rejected) {
    try {
      await store.delete("quarantine", upload.quarantineKey);
      result.swept += 1;
      cursor = upload.createdAt;
    } catch (error) {
      // The cursor stops before this upload: it is retried on the next run.
      result.failed += 1;
      logger.warn({ uploadId: upload.id, err: (error as Error).message }, "rejected upload sweep stopped");
      break;
    }
  }
  if (cursor) await writeRejectedSweepCursor(cursor, now);
}

/**
 * Next look at an upload of a removed listing: the listing's purgeAt (retention-purge deletes both
 * then), at least a day ahead (the nightly job may not have run yet); 30 days without a purgeAt.
 */
export function retainedUntil(listing: Pick<ListingRecord, "purgeAt">, now: Date): Date {
  const floor = now.getTime() + RETAINED_RECHECK_MS;
  if (!listing.purgeAt) return new Date(now.getTime() + ATTACHED_RECHECK_MS);
  return new Date(Math.max(listing.purgeAt.getTime(), floor));
}

async function purgeExpiredDocuments(store: ObjectStore, now: Date, result: PurgeQuarantineResult): Promise<void> {
  let page: PurgeCursor | undefined;
  let freedBytes = 0;
  for (let pages = 0; pages < PURGE_PAGES; pages += 1) {
    const uploads = await listPastPurge(now, PURGE_QUARANTINE_BATCH, page);
    if (uploads.length === 0) break;
    const listings = new Map((await getListings([...new Set(uploads.map((upload) => upload.targetId))])).map((listing) => [listing.id, listing]));
    for (const upload of uploads) {
      const listing = listings.get(upload.targetId);
      try {
        if (listing && listing.legalHold.length > 0) {
          await updateUpload(upload.id, { purgeAt: new Date(now.getTime() + HOLD_RECHECK_MS) }, now);
          result.skipped += 1;
        } else if (listing && RETAINED_STATUSES.includes(listing.status)) {
          await updateUpload(upload.id, { purgeAt: retainedUntil(listing, now) }, now);
          result.skipped += 1;
        } else if (listing?.photos.some((photo) => photo.id === upload.id)) {
          await updateUpload(upload.id, { purgeAt: new Date(now.getTime() + ATTACHED_RECHECK_MS) }, now);
          result.extended += 1;
        } else {
          await deleteObjects(store, upload, true);
          await deleteUploadDocument(upload.id);
          if (upload.status === "ready" && upload.size) freedBytes += upload.size;
          result.purged += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.warn({ uploadId: upload.id, err: (error as Error).message }, "expired upload not purged");
      }
    }
    const last = uploads[uploads.length - 1]!;
    page = { purgeAt: last.purgeAt, id: last.id };
    if (uploads.length < PURGE_QUARANTINE_BATCH) break;
  }
  if (freedBytes > 0) await recordMediaBytes(-freedBytes, now);
}

export async function purgeQuarantine(now = new Date(), deps: { store?: ObjectStore } = {}): Promise<PurgeQuarantineResult> {
  const result: PurgeQuarantineResult = { expired: 0, swept: 0, purged: 0, extended: 0, skipped: 0, failed: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("purge-quarantine skipped: Firebase not configured");
    return result;
  }
  let store: ObjectStore;
  try {
    store = deps.store ?? objectStore();
  } catch (error) {
    if (!isStorageNotConfigured(error)) throw error;
    // No bucket, so no upload was ever signed here.
    logger.warn("purge-quarantine skipped: object storage not configured");
    return result;
  }
  await expireStale(store, now, result);
  await sweepRejected(store, now, result);
  if (await isDegraded("firestore.deletes")) logger.warn("purge-quarantine: document purge deferred, Firestore delete quota degraded");
  else await purgeExpiredDocuments(store, now, result);
  logger.info({ ...result }, "purge-quarantine");
  return result;
}
