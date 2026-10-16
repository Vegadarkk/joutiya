import "server-only";
import { DEFAULT_AI, type AiConfig } from "@/config/ai";
import { MAX_UPLOAD_BYTES, PHOTO_VARIANTS, type ListingPhoto, type UploadRejectReason, type UploadStatusResponse } from "@/lib/contracts/media";
import { getListing, removePhoto, type ListingRecord } from "@/lib/db/repositories/listings";
import { recordModerationDecision } from "@/lib/db/repositories/moderation-decisions";
import { getUpload, markUploadReady, transitionUpload, type UploadRecord } from "@/lib/db/repositories/uploads";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { objectStore, type BucketRole, type ObjectStore } from "@/lib/storage";
import { AUTO_ATTACH_STATUSES, PHOTO_TARGET_STATUSES, maxPhotosOf, toStatusResponse } from "@/lib/uploads/policy";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";
import { imageClassifier, type ImageClassification, type ImageClassifier } from "./classify";
import { isMediaError } from "./errors";
import { checkImageType, SNIFF_BYTES } from "./magic";
import { processImage, type ProcessedImage } from "./process";
import { MEDIA_CACHE_CONTROL, MEDIA_CONTENT_TYPE, mediaObjectKey } from "./urls";

// processUpload (architecture §3 step 5, design §4 and D6): HEAD the quarantine object, delete it
// unread when it is too large, GET (capped at the declared size), sniff the real type, re-encode
// with sharp (EXIF/GPS dropped, orientation applied, pixel cap), run the local checks (a nudity
// score at the reject threshold refuses the photo before anything is published), put the two WebP
// variants, then one transaction marks the upload ready and attaches the photo to a draft, and the
// original is deleted last. A retry after any failure redoes the whole run from the original (puts
// overwrite the same keys, the final transaction only applies to a `processing` upload), and a
// ready upload never needs it. Runs in the worker (queue "media") or inline in the complete route
// without Valkey (D12).

export interface PipelineDeps {
  store?: ObjectStore;
  /** Defaults to the process-wide classifier (ONNX, or the stub without the model files). */
  classifier?: ImageClassifier;
  ai?: AiConfig;
  now?: () => Date;
}

interface Context {
  store: ObjectStore;
  classifier: ImageClassifier;
  /** The factory's stub stands in for missing models: its zeros are not stored as checks. */
  recordChecks: boolean;
  ai: AiConfig;
  now: () => Date;
}

/** CGU reference of automated refusals (same ground as the listing pre-moderation, D8). */
const AUTOMATED_GROUND = "CGU §7 (contrôle avant publication)";

function contextOf(deps: PipelineDeps): Context {
  const ai = deps.ai ?? DEFAULT_AI;
  const classifier = deps.classifier ?? imageClassifier(serverEnv(), ai);
  return {
    store: deps.store ?? objectStore(),
    classifier,
    recordChecks: deps.classifier !== undefined || classifier.name !== "stub",
    ai,
    now: deps.now ?? (() => new Date()),
  };
}

function variantKeys(upload: Pick<UploadRecord, "id" | "targetId">): string[] {
  return PHOTO_VARIANTS.map((variant) => mediaObjectKey(upload.targetId, upload.id, variant));
}

/** Storage deletions that must not stop a rejection: the purge job retries what fails here. */
async function deleteQuietly(store: ObjectStore, bucket: BucketRole, keys: readonly string[], uploadId: string): Promise<void> {
  for (const key of keys) {
    try {
      await store.delete(bucket, key);
    } catch (error) {
      logger.warn({ uploadId, bucket, err: (error as Error).message }, "upload object deletion deferred to the purge");
    }
  }
}

interface RejectExtras {
  /** Real size from the HEAD, recorded for the record. */
  size?: number;
  checks?: UploadRecord["checks"];
  /** Variants may exist (put before the rejection): delete them too. */
  variants?: boolean;
}

async function reject(upload: UploadRecord, reason: UploadRejectReason, ctx: Context, extras: RejectExtras = {}): Promise<UploadStatusResponse | null> {
  await deleteQuietly(ctx.store, "quarantine", [upload.quarantineKey], upload.id);
  if (extras.variants) await deleteQuietly(ctx.store, "media", variantKeys(upload), upload.id);
  const marked = await transitionUpload(
    upload.id,
    ["signed", "processing"],
    { status: "rejected", rejectReason: reason, ...(extras.size !== undefined ? { size: extras.size } : {}), ...(extras.checks ? { checks: extras.checks } : {}) },
    ctx.now(),
  );
  if (!marked.ok) return marked.upload ? toStatusResponse(marked.upload) : null;
  logger.info({ uploadId: upload.id, listingId: upload.targetId, reason }, "upload rejected");
  return { status: "rejected", rejectReason: reason };
}

/** Statement of reasons of an automated refusal (art. 17 DSA); the seller sees it at once in the wizard. */
async function recordNsfwRefusal(upload: UploadRecord, score: number, ctx: Context): Promise<void> {
  try {
    await recordModerationDecision({
      target: { type: "upload", id: upload.id },
      affectedUid: upload.ownerUid,
      action: "remove",
      facts: `photo nudity score ${score.toFixed(2)} >= ${ctx.ai.nsfw.rejectAt} (listing ${upload.targetId})`,
      origin: "own_initiative",
      automation: { detection: true, decision: true },
      ground: { type: "terms", ref: AUTOMATED_GROUND, explanation: "Automated nudity check refused the photo at upload; it was never published." },
      reportIds: [],
      templateId: "photoRejectedNsfw",
      decidedBy: "system",
      notified: true,
      now: ctx.now(),
    });
  } catch (error) {
    logger.error({ uploadId: upload.id, err: (error as Error).message }, "nsfw refusal not recorded");
  }
}

function checksOf(result: ImageClassification, ctx: Context): UploadRecord["checks"] {
  if (!ctx.recordChecks) return {};
  return { nsfw: Math.min(1, Math.max(0, result.nsfw)), faces: Math.max(0, Math.round(result.faces)) };
}

/**
 * Runs the pipeline on a `processing` upload. Idempotent: a ready or rejected upload answers its
 * status unchanged, a `signed` one (complete not called yet) answers processing. Null when the
 * upload document is gone (deleted by its owner meanwhile). Media failures become rejections;
 * infrastructure failures throw (the worker retries, the complete route expires the upload).
 */
export async function processUpload(uploadId: string, deps: PipelineDeps = {}): Promise<UploadStatusResponse | null> {
  const upload = await getUpload(uploadId);
  if (!upload) return null;
  if (upload.status !== "processing") return toStatusResponse(upload);
  return run(upload, contextOf(deps));
}

async function run(upload: UploadRecord, ctx: Context): Promise<UploadStatusResponse | null> {
  const listing = await getListing(upload.targetId);
  if (!listing || !PHOTO_TARGET_STATUSES.includes(listing.status)) return reject(upload, "expired", ctx);

  const head = await ctx.store.head("quarantine", upload.quarantineKey);
  // Never PUT (complete called first) or purged: nothing to process.
  if (!head) return reject(upload, "expired", ctx);
  // Size gate before any read (§6 uploads): R2 cannot cap a presigned PUT, so the HEAD decides.
  // Larger than declared means the byte quota was dodged: refused the same way.
  if (head.size > MAX_UPLOAD_BYTES || head.size > upload.declaredSize) return reject(upload, "too_large", ctx, { size: head.size });

  // Capped read: a second PUT between the HEAD and the GET cannot load more than declared into memory.
  const original = await ctx.store.get("quarantine", upload.quarantineKey, { maxBytes: upload.declaredSize });
  if (!original) return reject(upload, "expired", ctx, { size: head.size });
  if (original.byteLength > upload.declaredSize) return reject(upload, "too_large", ctx, { size: original.byteLength });
  if ("reason" in checkImageType(original.subarray(0, SNIFF_BYTES), upload.declaredType)) return reject(upload, "bad_type", ctx, { size: head.size });

  let processed: ProcessedImage;
  try {
    processed = await processImage(original);
  } catch (error) {
    if (isMediaError(error)) return reject(upload, error.reason, ctx, { size: head.size });
    throw error;
  }

  // The checks read the re-encoded `l` variant: oriented, metadata-free, at most 1600 px.
  const result = await ctx.classifier.classify(processed.variants.l);
  const checks = checksOf(result, ctx);
  if (result.nsfw >= ctx.ai.nsfw.rejectAt) {
    await recordNsfwRefusal(upload, result.nsfw, ctx);
    return reject(upload, "nsfw", ctx, { size: head.size, checks });
  }
  return publish(upload, listing, processed, checks, ctx);
}

async function publish(upload: UploadRecord, listing: ListingRecord, processed: ProcessedImage, checks: UploadRecord["checks"], ctx: Context): Promise<UploadStatusResponse | null> {
  const maxPhotos = maxPhotosOf(listing);
  const attachable = AUTO_ATTACH_STATUSES.includes(listing.status) || listing.photos.some((photo) => photo.id === upload.id);
  // A full live listing cannot take it either: refused before anything is stored.
  if (!attachable && listing.photos.length >= maxPhotos) return reject(upload, "quota", ctx, { checks });

  for (const variant of PHOTO_VARIANTS) {
    await ctx.store.put("media", mediaObjectKey(listing.id, upload.id, variant), processed.variants[variant], { contentType: MEDIA_CONTENT_TYPE, cacheControl: MEDIA_CACHE_CONTROL });
  }
  const photo: ListingPhoto = { id: upload.id, w: processed.width, h: processed.height, blurhash: processed.blurhash, hash: processed.hash };
  const storedBytes = PHOTO_VARIANTS.reduce((sum, variant) => sum + processed.variants[variant].byteLength, 0);
  const outcome = await markUploadReady(
    upload.id,
    {
      size: storedBytes,
      width: processed.width,
      height: processed.height,
      blurhash: processed.blurhash,
      hash: processed.hash,
      checks,
      variants: [...PHOTO_VARIANTS],
      finalKey: `listings/${listing.id}/${upload.id}`,
    },
    { listingId: listing.id, photo, maxPhotos, targetStatuses: PHOTO_TARGET_STATUSES, attachStatuses: AUTO_ATTACH_STATUSES },
    ctx.now(),
  );
  if (!outcome.ok) {
    if (outcome.reason === "photo_limit") return reject(upload, "quota", ctx, { checks, variants: true });
    if (outcome.reason === "gone") return reject(upload, "expired", ctx, { checks, variants: true });
    // Another run already finished (same keys): keep its result.
    if (outcome.upload?.status === "ready") return toStatusResponse(outcome.upload);
    // Deleted by its owner or expired meanwhile: remove what this run stored.
    await deleteQuietly(ctx.store, "media", variantKeys(upload), upload.id);
    await deleteQuietly(ctx.store, "quarantine", [upload.quarantineKey], upload.id);
    return outcome.upload ? toStatusResponse(outcome.upload) : null;
  }
  await recordMediaBytes(storedBytes, ctx.now());
  await deleteQuietly(ctx.store, "quarantine", [upload.quarantineKey], upload.id);
  logger.info({ uploadId: upload.id, listingId: listing.id, bytes: storedBytes, attached: outcome.attached }, "upload ready");
  return { status: "ready", photo };
}

/**
 * Gives up on an upload after an infrastructure failure (last worker attempt, inline error):
 * `rejected` with reason `expired` (the wizard offers a retry), objects deleted best effort.
 */
export async function expireUpload(uploadId: string, deps: Pick<PipelineDeps, "store" | "now"> = {}): Promise<UploadStatusResponse | null> {
  const upload = await getUpload(uploadId);
  if (!upload) return null;
  if (upload.status === "ready" || upload.status === "rejected") return toStatusResponse(upload);
  let store: ObjectStore | undefined = deps.store;
  try {
    store ??= objectStore();
  } catch {
    store = undefined;
  }
  const now = deps.now ?? (() => new Date());
  const listing = await getListing(upload.targetId).catch(() => null);
  const attached = listing?.photos.some((photo) => photo.id === upload.id) ?? false;
  // Attached to a listing that went live meanwhile: its variants stay (the page shows them);
  // purge-quarantine keeps attached photos. Otherwise the photo goes entirely.
  const keepVariants = attached && !AUTO_ATTACH_STATUSES.includes(listing!.status);
  if (attached && !keepVariants) await removePhoto(listing!.id, upload.id, now());
  if (store) {
    await deleteQuietly(store, "quarantine", [upload.quarantineKey], upload.id);
    if (!keepVariants) await deleteQuietly(store, "media", variantKeys(upload), upload.id);
  }
  const marked = await transitionUpload(upload.id, ["signed", "processing"], { status: "rejected", rejectReason: "expired" }, now());
  if (!marked.ok) return marked.upload ? toStatusResponse(marked.upload) : null;
  return { status: "rejected", rejectReason: "expired" };
}
