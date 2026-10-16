import "server-only";
import { requireOwner, type AuthContext } from "@/lib/auth/guards";
import {
  PHOTO_VARIANTS,
  UPLOAD_URL_TTL_SECONDS,
  UPLOADS_PER_PHOTO_SLOT,
  type SignUploadInput,
  type SignUploadResponse,
  type UploadStatusResponse,
} from "@/lib/contracts/media";
import { recordContentOp } from "@/lib/db/repositories/content-ops";
import type { ListingStatus } from "@/lib/contracts/listings";
import { getListing, type ListingRecord } from "@/lib/db/repositories/listings";
import {
  countUploadsByTarget,
  createUpload,
  deleteUploadDocument,
  detachPhoto,
  getUpload,
  LastPhotoError,
  listUploadsByTarget,
  newUploadId,
  transitionUpload,
  UPLOAD_RETENTION_DAYS,
  type UploadRecord,
} from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { HttpError, notFound, unavailable } from "@/lib/http/errors";
import { PUBLIC_STATES } from "@/lib/listings/public";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { expireUpload } from "@/lib/media/pipeline";
import { dispatchUpload, enqueueMediaJob, isMediaQueueEnabled } from "@/lib/media/queue";
import { photoObjectKey, quarantineObjectKey, type PhotoBucket } from "@/lib/media/urls";
import { captureServerException } from "@/lib/observability/capture";
import { assertQuotas, DEPOSIT_QUOTAS } from "@/lib/quota/gate";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { notifySearchIndex } from "@/lib/search/queue";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { LIVE_STATUSES, PHOTO_TARGET_STATUSES, maxPhotosOf, toStatusResponse } from "./policy";
import { isStorageFull, recordMediaBytes } from "./storage-gauge";

// Uploads service (design §3 MEDIA_API, architecture §6 "Uploads"): signing a presigned PUT to
// the quarantine bucket, completing (processing inline or queued, D12), status and deletion. The
// caller is a signed-in member (handlers.ts); an upload or listing of someone else answers 404.

export interface Uploader {
  auth: AuthContext;
  /** Clear client IP (contentOps, LCEN); "" when unknown. */
  ip: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A signed upload still counts against the photo limit while its URL can be used (5 min) plus margin. */
const SIGNED_HOLD_MS = 2 * UPLOAD_URL_TTL_SECONDS * 1000;

function store(): ObjectStore {
  try {
    return objectStore();
  } catch (error) {
    // Deployed without the R2 variables: uploads are off until the bucket tokens exist.
    if (isStorageNotConfigured(error)) throw unavailable("object storage is not configured");
    throw error;
  }
}

async function ownedListing(uploader: Uploader, listingId: string): Promise<ListingRecord> {
  const listing = await getListing(listingId);
  if (!listing) throw notFound();
  requireOwner(uploader.auth, listing);
  return listing;
}

/** The caller's upload; anyone else's (or a missing one) answers 404, never 403 (IDOR). */
async function ownedUpload(uploader: Uploader, id: string): Promise<UploadRecord> {
  const upload = await getUpload(id);
  if (!upload || upload.ownerUid !== uploader.auth.user.uid) throw notFound();
  return upload;
}

export const uploadContentRef = (id: string) => `${COLLECTIONS.uploads}/${id}`;

/**
 * POST /api/uploads/sign: the caller's editable listing, room for one more photo, storage and
 * Firestore writes not degraded, 30 signatures an hour and 200 MiB declared a day; then the
 * `signed` document and a presigned PUT bound to the declared type (and length, where the adapter
 * signs it), 5 minutes.
 */
export async function signUpload(uploader: Uploader, input: SignUploadInput, now = new Date()): Promise<SignUploadResponse> {
  const { uid } = uploader.auth.user;
  const objects = store();
  if (await isStorageFull()) throw new HttpError(503, "storage_full", undefined, { headers: { "Retry-After": "3600" } });
  await enforceLimit("upload.sign.uid", uid);
  // Deposit suspended (src/lib/quota/gate.ts): before the listing read and the upload document.
  await assertQuotas(DEPOSIT_QUOTAS);

  const listing = await ownedListing(uploader, input.targetId);
  if (!PHOTO_TARGET_STATUSES.includes(listing.status)) throw notFound();
  // Every upload document of the listing is read by the owner's view: their number is capped
  // (refused ones stay 7 days unless removed), one aggregation read.
  if ((await countUploadsByTarget(listing.id)) >= UPLOADS_PER_PHOTO_SLOT * maxPhotosOf(listing)) throw new HttpError(409, "upload_limit", "too many uploads on this listing");
  const attached = new Set(listing.photos.map((photo) => photo.id));
  const inFlight = (await listUploadsByTarget(listing.id, ["signed", "processing"])).filter(
    (upload) => !attached.has(upload.id) && (upload.status === "processing" || now.getTime() - upload.createdAt.getTime() < SIGNED_HOLD_MS),
  );
  if (attached.size + inFlight.length >= maxPhotosOf(listing)) throw new HttpError(409, "photo_limit");

  // Points = declared bytes; the pipeline refuses an object larger than declared.
  await enforceLimit("upload.bytes.uid", uid, input.declaredSize);

  const id = newUploadId();
  const quarantineKey = quarantineObjectKey(id);
  await createUpload(id, {
    ownerUid: uid,
    purpose: input.purpose,
    targetId: listing.id,
    declaredSize: input.declaredSize,
    declaredType: input.declaredType,
    status: "signed",
    quarantineKey,
    bucket: "media",
    checks: {},
    purgeAt: new Date(now.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS),
    createdAt: now,
    updatedAt: now,
  });
  const signed = await objects.presignPut({ bucket: "quarantine", key: quarantineKey, contentType: input.declaredType, contentLength: input.declaredSize, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
  if (uploader.ip) await recordContentOp({ uid, op: "upload.create", contentRef: uploadContentRef(id), ip: uploader.ip, now });
  return { uploadId: id, url: signed.url, method: "PUT", headers: { "Content-Type": input.declaredType }, expiresAt: signed.expiresAt.toISOString() };
}

/**
 * POST /api/uploads/{id}/complete: `signed` -> `processing`, then the pipeline (inline without
 * Valkey: the answer is final; queued otherwise: `processing`, the client polls). Repeating it is
 * harmless: a finished upload answers its status, a queued one is re-enqueued (same job id).
 */
export async function completeUpload(uploader: Uploader, id: string, now = new Date()): Promise<UploadStatusResponse> {
  const upload = await ownedUpload(uploader, id);
  if (upload.status === "ready" || upload.status === "rejected") return toStatusResponse(upload);
  const started = await transitionUpload(id, ["signed"], { status: "processing" }, now);
  if (!started.ok) {
    if (!started.upload) throw notFound();
    if (started.upload.status === "processing" && isMediaQueueEnabled()) {
      // Usually still queued (same job id, ignored); re-added if it was lost. The answer stays `processing`.
      await enqueueMediaJob(id).catch((error: unknown) => logger.warn({ uploadId: id, err: (error as Error).message }, "media job not re-enqueued"));
    }
    return toStatusResponse(started.upload);
  }
  let result: UploadStatusResponse | null;
  try {
    result = await dispatchUpload(id);
  } catch (error) {
    if (isMediaQueueEnabled()) {
      // Not enqueued, nothing will process it: back to `signed`, so complete can be called again.
      await transitionUpload(id, ["processing"], { status: "signed" }).catch(() => undefined);
      logger.error({ uploadId: id, err: (error as Error).message }, "media job not enqueued");
      throw unavailable("media queue unavailable");
    }
    // Inline (dev): an infrastructure failure expires the upload; the wizard offers a retry.
    captureServerException(error, { route: "uploads.complete", uploadId: id });
    result = await expireUpload(id).catch(() => {
      throw error;
    });
  }
  // Null: deleted by its owner while it was processing.
  if (!result) throw notFound();
  return result;
}

/** GET /api/uploads/{id}: the owner's status (the wizard polls it while the worker runs). */
export async function uploadStatus(uploader: Uploader, id: string): Promise<UploadStatusResponse> {
  return toStatusResponse(await ownedUpload(uploader, id));
}

const photosRequired = () => new HttpError(422, "invalid_listing", undefined, { details: [{ path: "photos", code: "photos_required" }] });

/** Listings whose photo changes are logged in contentOps like an edit (LCEN): public pages and listings held for review. */
const LOGGED_STATUSES: readonly ListingStatus[] = [...PUBLIC_STATES, "pending_review"];

/**
 * Detaches the photo. The transaction that removes it also queues the re-indexing of a published
 * listing and logs the change of a public or held one (contentOps `listing.update`, like a PATCH);
 * a public page is revalidated once it is written.
 */
async function detach(uploader: Uploader, listingId: string, id: string, keepOneStatuses: readonly ListingStatus[], now: Date): Promise<void> {
  let detached: Awaited<ReturnType<typeof detachPhoto>>;
  try {
    detached = await detachPhoto(listingId, id, keepOneStatuses, now, {
      searchStatuses: ["published"],
      contentOp: { uid: uploader.auth.user.uid, ip: uploader.ip, statuses: LOGGED_STATUSES },
    });
  } catch (error) {
    if (error instanceof LastPhotoError) throw photosRequired();
    throw error;
  }
  const { listing, changed } = detached;
  if (changed && listing?.status === "published") await notifySearchIndex([listingId]);
  if (!changed || !listing || !(PUBLIC_STATES as readonly ListingStatus[]).includes(listing.status)) return;
  revalidateListingPaths({ slugId: listing.slugId, publicId: listing.sellerPublicId });
}

/**
 * DELETE /api/uploads/{id}: detaches the photo from the listing (a live listing keeps at least one
 * photo: 422, like a PATCH), ends the upload, deletes the quarantine object and the variants, then
 * the document. The upload leaves `processing` before anything is deleted, so a pipeline run still
 * in flight finds it gone and removes what it stored; the second detach catches a photo that run
 * attached in between. Under a legal hold the upload ends the same way, then nothing more is
 * deleted: its objects and its document stay as evidence (purge-quarantine deletes them past
 * purgeAt once the hold is lifted). A read-only listing keeps its photos: sold and removed ones
 * are retained with their text until retention-purge (§7 retention table): 409, nothing changes.
 */
export async function deleteUpload(uploader: Uploader, id: string, now = new Date()): Promise<void> {
  const upload = await ownedUpload(uploader, id);
  const objects = store();
  const listing = await getListing(upload.targetId);
  if (listing && !PHOTO_TARGET_STATUSES.includes(listing.status)) throw new HttpError(409, "conflict", `the photos of a ${listing.status} listing are retained with it`);
  if (listing) await detach(uploader, listing.id, id, LIVE_STATUSES, now);
  const held = listing !== null && listing.legalHold.length > 0;
  // A photo deleted earlier under a hold now lifted still has its variants, and its bytes counted.
  let freedBytes = upload.status === "ready" || upload.heldObjects ? (upload.size ?? 0) : 0;
  if (upload.status !== "rejected") {
    // Out of `ready` first, hold or not: a document kept as evidence is never attached or offered
    // for the next save again (the owner's view lists it as refused until it is purged). Its
    // variants stay under a hold: `heldObjects` (set from the record the transaction reads, so a
    // pipeline run that finished meanwhile is caught) keeps them in the storage gauge's recount.
    const ended = await transitionUpload(
      id,
      ["signed", "processing", "ready"],
      (current) => ({ status: "rejected", rejectReason: "expired", ...(held && current.status === "ready" ? { heldObjects: true as const } : {}) }),
      now,
    );
    if (!ended.ok && !ended.upload) throw notFound();
    // Finished by the pipeline between the read and the transition: its bytes were counted.
    if (ended.ok && upload.status !== "ready" && ended.upload.variants) freedBytes = ended.upload.size ?? 0;
    // Past the point of no return: the photo goes even if it was the last one.
    if (listing && upload.status !== "ready") await detach(uploader, listing.id, id, [], now);
  }
  if (held) {
    logger.info({ uploadId: id, listingId: listing.id }, "upload kept under legal hold");
    return;
  }
  await objects.delete("quarantine", upload.quarantineKey);
  // A photo moved off the public bucket (removed listing, now an orphan) is in `private`; a move cut
  // short may have left its public copy too, so both go (as in retention-purge).
  const buckets: readonly PhotoBucket[] = upload.bucket === "private" ? ["private", "media"] : ["media"];
  for (const bucket of buckets) for (const variant of PHOTO_VARIANTS) await objects.delete(bucket, photoObjectKey(bucket, upload.targetId, id, variant));
  await deleteUploadDocument(id);
  if (freedBytes > 0) await recordMediaBytes(-freedBytes, now);
}
