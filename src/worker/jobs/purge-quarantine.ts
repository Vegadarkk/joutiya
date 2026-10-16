import { LEGACY_PHOTO_VARIANTS, PHOTO_VARIANTS, type PhotoVariant } from "@/lib/contracts/media";
import { getListings, type ListingRecord } from "@/lib/db/repositories/listings";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { listListingsChangedBefore, type ListingCursor } from "@/lib/db/repositories/retention";
import {
  deleteUploadDocument,
  listExpiredQuarantine,
  listPastPurge,
  listRejectedCreatedBetween,
  listUploadsByTarget,
  readRejectedSweepCursor,
  readRetainedScanCursor,
  transitionUpload,
  updateUpload,
  UPLOADS_BY_TARGET_LIMIT,
  writeRejectedSweepCursor,
  writeRetainedScanCursor,
  type PurgeCursor,
  type UploadRecord,
} from "@/lib/db/repositories/uploads";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { MEDIA_CONTENT_TYPE, photoFinalKey, photoObjectKey, type PhotoBucket } from "@/lib/media/urls";
import { kybcObjectKey } from "@/lib/pro/kybc";
import { kybcRetention } from "@/lib/pro/kybc-retention";
import { isDegraded } from "@/lib/quota";
import { isStorageNotConfigured, moveObject, objectStore, type ObjectStore } from "@/lib/storage";
import { RETAINED_STATUSES, storedBytes } from "@/lib/uploads/policy";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";

// Hourly at :20 (design §4, architecture §6 "Les objets non traités sont purgés après 24 h"):
// 1. uploads still `signed` or `processing` 24 h after signing: upload `rejected` with reason
//    `expired`, then its quarantine object (and any variant) deleted;
// 2. `rejected` uploads: their quarantine object deleted once no presigned PUT can land any more
//    (the pipeline deletes it at once; this catches failed deletions and a PUT sent after
//    complete), swept in creation order behind a cursor (system/purgeQuarantine);
// 3. photos of removed listings leave the public media bucket (architecture §5: kept until
//    removal + 12 months for appeals and authority requests, never served meanwhile): removed
//    listings are scanned by updatedAt behind a cursor (system/purgeQuarantine, 10 minutes behind
//    the clock so a removal still committing is not passed over), and the variants of each `ready`
//    upload (or `rejected` once ready: deleted by its owner under a legal hold, objects kept) move
//    to the private bucket under `removed/listings/...` (GET, PUT, HEAD check, then DELETE of the
//    public copy), after which the upload records `bucket: "private"` and its finalKey. A rerun
//    finishes whatever a crash left (moveObject). A legal hold does not stop it: no public copy
//    goes before its private copy is checked. An upload that fails is handed to the document
//    purge (purgeAt = now), which retries the move every hour;
// 4. documents past purgeAt not attached to a listing: objects and document deleted. An attached
//    photo lives with its listing: its purgeAt moves to the listing's purgeAt (expiry or end +
//    purge months), or 30 days on when that is sooner or unset (drafts). The uploads of a removed
//    listing are retention-purge's (deleted with the listing at its purgeAt, removal + 12 months):
//    their variants move to the private bucket if step 3 has not done it yet, then their purgeAt
//    moves to the listing's. A legal hold keeps everything, rechecked daily. A purged listing
//    (tombstone) does not read as a listing: its uploads are orphans, deleted (both buckets).
//    Every skipped upload gets a later purgeAt, so no run reads it again before then. A KYBC piece
//    (phase 7) follows its owner's application instead (src/lib/pro/kybc-retention.ts).
// Steps 2 to 4 never mark anything before its objects are handled: a storage failure leaves the
// upload for the next run. Moving photos changes no byte count: the R2 storage gauge sums the
// uploads whose variants are stored (`ready`, and `heldObjects`), whichever bucket holds them
// (account total).
//
// Edge cache: the public URL of a moved variant answers 404 at R2, but Cloudflare and browsers may
// still serve a copy cached before the move, up to the object's max-age (MEDIA_CACHE_CONTROL: one
// year, immutable); the app has no Cloudflare token to purge it.

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
/** The scan of removed listings stays this far behind the clock (a removal still committing keeps an earlier updatedAt). */
export const RETAINED_SCAN_LAG_MS = 10 * 60_000;
export const RETAINED_SCAN_BATCH = 25;
export const RETAINED_SCAN_PAGES = 4;
/** Memory guard of a move: a variant is a WebP of at most 1600 px, far below. */
export const MAX_VARIANT_BYTES = 8 * 1024 * 1024;

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
  /** Uploads of removed listings whose variants moved to the private bucket (steps 3 and 4). */
  retained: number;
  /** Bytes of stored variants deleted with their documents (step 4), taken off the R2 storage gauge. */
  freedBytes: number;
  failed: number;
}

/** The quarantine object, then the variants in each of `buckets` (deletions are idempotent). */
async function deleteObjects(store: ObjectStore, upload: UploadRecord, buckets: readonly PhotoBucket[]): Promise<void> {
  await store.delete("quarantine", upload.quarantineKey);
  for (const bucket of buckets) for (const variant of PHOTO_VARIANTS) await store.delete(bucket, photoObjectKey(bucket, upload.targetId, upload.id, variant));
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
      // the document purge (step 4) at purgeAt, and the quarantine lifecycle rule backs it up.
      await deleteObjects(store, upload, upload.status === "processing" ? ["media"] : []);
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

/** Upload statuses whose variants may be in the media bucket: ready, or rejected after it (a deletion under a legal hold keeps them). */
export const RETAINABLE_UPLOAD_STATUSES = ["ready", "rejected"] as const;

/**
 * A photo whose variants are still in the public media bucket: `ready`, or `rejected` once ready
 * (`variants` recorded: the owner deleted it under a legal hold, the objects stay as evidence).
 */
export function isPublicPhoto(upload: Pick<UploadRecord, "purpose" | "status" | "bucket" | "variants">): boolean {
  if (upload.purpose !== "listing" || upload.bucket !== "media") return false;
  return upload.status === "ready" || (upload.status === "rejected" && (upload.variants?.length ?? 0) > 0);
}

/**
 * Moves a photo's variants from the media bucket to the private one: every variant name, since a
 * record may not list one it has (no public copy may stay). Returns how many of `expected` (the
 * variants the record lists) are in neither bucket.
 */
async function moveVariantsToPrivate(store: ObjectStore, listingId: string, photoId: string, expected: readonly PhotoVariant[]): Promise<number> {
  let missing = 0;
  for (const variant of PHOTO_VARIANTS) {
    const outcome = await moveObject(
      store,
      { bucket: "media", key: photoObjectKey("media", listingId, photoId, variant) },
      { bucket: "private", key: photoObjectKey("private", listingId, photoId, variant) },
      { contentType: MEDIA_CONTENT_TYPE, maxBytes: MAX_VARIANT_BYTES },
    );
    if (outcome === "missing" && expected.includes(variant)) missing += 1;
  }
  return missing;
}

/**
 * Moves the variants of a removed listing's photo from the media bucket to the private one, then
 * records `bucket: "private"` and the new finalKey on the upload (transaction: still ready or rejected).
 * Idempotent; throws on a storage failure, when the public copy of any variant whose private copy
 * is not checked yet is still in place. False when the upload changed meanwhile (not recorded).
 */
export async function retainUpload(store: ObjectStore, upload: UploadRecord, now: Date): Promise<boolean> {
  const missing = await moveVariantsToPrivate(store, upload.targetId, upload.id, upload.variants ?? LEGACY_PHOTO_VARIANTS);
  if (missing > 0) logger.warn({ uploadId: upload.id, missing }, "retained photo: variant found in neither bucket");
  const marked = await transitionUpload(upload.id, RETAINABLE_UPLOAD_STATUSES, { bucket: "private", finalKey: photoFinalKey("private", upload.targetId, upload.id) }, now);
  if (!marked.ok) logger.warn({ uploadId: upload.id }, "retained photo: upload changed meanwhile, location not recorded");
  return marked.ok;
}

/** Every public photo of a removed listing; a failed one is handed to the document purge. Throws when even that fails. */
async function retainListingPhotos(store: ObjectStore, listing: ListingRecord, now: Date, result: PurgeQuarantineResult): Promise<void> {
  // Signing caps a listing far below one page; anything beyond moves at its own purgeAt (step 4).
  const uploads = await listUploadsByTarget(listing.id, RETAINABLE_UPLOAD_STATUSES);
  if (uploads.length >= UPLOADS_BY_TARGET_LIMIT) logger.warn({ listingId: listing.id }, "removed listing: more ready or rejected uploads than one page");
  for (const upload of uploads) {
    if (!isPublicPhoto(upload)) continue;
    try {
      if (await retainUpload(store, upload, now)) result.retained += 1;
    } catch (error) {
      result.failed += 1;
      logger.warn({ uploadId: upload.id, err: (error as Error).message }, "removed listing photo not moved, retried by the document purge");
      if (upload.purgeAt.getTime() > now.getTime()) await updateUpload(upload.id, { purgeAt: now }, now);
    }
  }
  // An attached photo without an upload document (lost): its keys are still derivable. A failure
  // stops the scan here (no document to hand over).
  const known = new Set(uploads.map((upload) => upload.id));
  for (const photo of listing.photos) if (!known.has(photo.id)) await moveVariantsToPrivate(store, listing.id, photo.id, photo.variants ?? LEGACY_PHOTO_VARIANTS);
}

async function retainRemovedPhotos(store: ObjectStore, now: Date, result: PurgeQuarantineResult): Promise<void> {
  const before = new Date(now.getTime() - RETAINED_SCAN_LAG_MS);
  let cursor: ListingCursor | undefined = (await readRetainedScanCursor()) ?? undefined;
  let done: ListingCursor | null = null;
  for (let pages = 0; pages < RETAINED_SCAN_PAGES; pages += 1) {
    const page = await listListingsChangedBefore(RETAINED_STATUSES, before, RETAINED_SCAN_BATCH, cursor);
    for (const listing of page.listings) {
      try {
        await retainListingPhotos(store, listing, now, result);
      } catch (error) {
        // Nothing handed over: the cursor stops before this listing and the next run starts from it.
        result.failed += 1;
        logger.warn({ listingId: listing.id, err: (error as Error).message }, "removed listing scan stopped");
        if (done) await writeRetainedScanCursor(done, now);
        return;
      }
      done = { at: listing.updatedAt, id: listing.id };
    }
    // Past the page's last document, parsed or not.
    if (page.next) done = page.next;
    if (!page.next || page.read < RETAINED_SCAN_BATCH) break;
    cursor = page.next;
  }
  if (done) await writeRetainedScanCursor(done, now);
}

/**
 * Next look at a photo attached to a listing that is not removed: the listing's purgeAt when it is
 * later than 30 days (retention-purge deletes the photo with the listing then; a save that drops
 * the photo brings its purgeAt back to now), else 30 days.
 */
export function attachedUntil(listing: Pick<ListingRecord, "purgeAt">, now: Date): Date {
  const recheck = now.getTime() + ATTACHED_RECHECK_MS;
  return new Date(listing.purgeAt && listing.purgeAt.getTime() > recheck ? listing.purgeAt.getTime() : recheck);
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

/** A KYBC piece past purgeAt (phase 7): kept with its owner's application, else deleted from both buckets. */
async function purgeKybcPiece(store: ObjectStore, upload: UploadRecord, now: Date, result: PurgeQuarantineResult): Promise<void> {
  try {
    const user = await getUserRecord(upload.ownerUid);
    const profile = user?.proId ? await getProProfile(user.proId) : null;
    const retention = kybcRetention(upload.id, profile && profile.ownerUid === upload.ownerUid ? profile : null, now);
    if (retention.keep) {
      await updateUpload(upload.id, { purgeAt: retention.until }, now);
      result.extended += 1;
      return;
    }
    await store.delete("quarantine", upload.quarantineKey);
    await store.delete("private", kybcObjectKey(upload.ownerUid, upload.id));
    if (await deleteUploadDocument(upload.id)) result.purged += 1;
  } catch (error) {
    result.failed += 1;
    logger.warn({ uploadId: upload.id, err: (error as Error).message }, "expired KYBC piece not purged");
  }
}

async function purgeExpiredDocuments(store: ObjectStore, now: Date, result: PurgeQuarantineResult): Promise<void> {
  try {
    await purgeExpiredPages(store, now, result);
  } finally {
    // Documents already removed give their bytes back even when a later page's query fails.
    if (result.freedBytes > 0) await recordMediaBytes(-result.freedBytes, now);
  }
}

async function purgeExpiredPages(store: ObjectStore, now: Date, result: PurgeQuarantineResult): Promise<void> {
  let page: PurgeCursor | undefined;
  for (let pages = 0; pages < PURGE_PAGES; pages += 1) {
    const uploads = await listPastPurge(now, PURGE_QUARANTINE_BATCH, page);
    if (uploads.length === 0) break;
    const listings = new Map((await getListings([...new Set(uploads.filter((upload) => upload.purpose !== "kyb").map((upload) => upload.targetId))])).map((listing) => [listing.id, listing]));
    for (const upload of uploads) {
      if (upload.purpose === "kyb") {
        await purgeKybcPiece(store, upload, now, result);
        continue;
      }
      const listing = listings.get(upload.targetId);
      try {
        const retained = listing !== undefined && RETAINED_STATUSES.includes(listing.status);
        // Backstop of step 3 (a hold allows it: the private copy is checked before the public one goes).
        if (retained && isPublicPhoto(upload) && (await retainUpload(store, upload, now))) result.retained += 1;
        if (listing && listing.legalHold.length > 0) {
          await updateUpload(upload.id, { purgeAt: new Date(now.getTime() + HOLD_RECHECK_MS) }, now);
          result.skipped += 1;
        } else if (listing && retained) {
          await updateUpload(upload.id, { purgeAt: retainedUntil(listing, now) }, now);
          result.skipped += 1;
        } else if (listing?.photos.some((photo) => photo.id === upload.id)) {
          await updateUpload(upload.id, { purgeAt: attachedUntil(listing, now) }, now);
          result.extended += 1;
        } else {
          // An orphan may have been a removed listing's: its variants can be in either bucket.
          await deleteObjects(store, upload, upload.bucket === "private" || !listing ? ["media", "private"] : ["media"]);
          // By the document as this run removed it: an owner DELETE or retention-purge may have ended
          // or removed it since the listing, and then its bytes (and its count) were theirs.
          const removed = await deleteUploadDocument(upload.id);
          result.freedBytes += storedBytes(removed);
          if (removed) result.purged += 1;
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
}

export async function purgeQuarantine(now = new Date(), deps: { store?: ObjectStore } = {}): Promise<PurgeQuarantineResult> {
  const result: PurgeQuarantineResult = { expired: 0, swept: 0, purged: 0, extended: 0, skipped: 0, retained: 0, freedBytes: 0, failed: 0 };
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
  if (await isDegraded("firestore.writes")) logger.warn("purge-quarantine: removed listing photos deferred, Firestore write quota degraded");
  else await step("retained photos", result, () => retainRemovedPhotos(store, now, result));
  if (await isDegraded("firestore.deletes")) logger.warn("purge-quarantine: document purge deferred, Firestore delete quota degraded");
  else await purgeExpiredDocuments(store, now, result);
  logger.info({ ...result }, "purge-quarantine");
  return result;
}

/** A failing query stops that step only: the document purge still runs. */
async function step(name: string, result: PurgeQuarantineResult, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    result.failed += 1;
    logger.error({ step: name, err: (error as Error).message }, "purge-quarantine step failed");
  }
}
