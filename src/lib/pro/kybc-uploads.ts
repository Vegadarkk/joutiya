import "server-only";
import { UPLOAD_URL_TTL_SECONDS } from "@/lib/contracts/media";
import type { KybcCompleteResponse, KybcSignInput, KybcSignResponse } from "@/lib/contracts/pro";
import { recordContentOp } from "@/lib/db/repositories/content-ops";
import { countUploadsByTarget, createUpload, getUpload, newUploadId, transitionUpload, UPLOAD_RETENTION_DAYS, type UploadRecord } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { HttpError, notFound, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { quarantineObjectKey } from "@/lib/media/urls";
import { assertQuotas, DEPOSIT_QUOTAS } from "@/lib/quota/gate";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { isStorageFull } from "@/lib/uploads/storage-gauge";
import { KYBC_SNIFF_BYTES, KYBC_UPLOADS_PER_ACCOUNT, kybcObjectKey, sniffKybcType } from "./kybc";
import type { ProActor } from "./service";

// KYBC pieces of a Pro application (phase 7 design §4, repo-map 5.2): same presigned PUT to the
// quarantine bucket as listing photos, but no image pipeline. `complete` checks the size and the
// real type (magic bytes: JPEG, PNG or PDF, equal to the declared type), copies the bytes to the
// private bucket under kyb/{uid}/{id} (never public), deletes the quarantine object and marks the
// upload `ready`. Done inline: one piece of at most 10 MiB per request, no variants. The pieces
// stay until purgeAt (7 days) unless an application lists them: purge-quarantine then keeps them
// with the application (design §4 retention).

const DAY_MS = 24 * 60 * 60 * 1000;

function store(): ObjectStore {
  try {
    return objectStore();
  } catch (error) {
    if (isStorageNotConfigured(error)) throw unavailable("object storage is not configured");
    throw error;
  }
}

const contentRef = (id: string) => `${COLLECTIONS.uploads}/${id}`;

export async function signKybcUpload(actor: ProActor, input: KybcSignInput, now = new Date()): Promise<KybcSignResponse> {
  const uid = actor.auth.user.uid;
  const objects = store();
  if (await isStorageFull()) throw new HttpError(503, "storage_full", undefined, { headers: { "Retry-After": "3600" } });
  await enforceLimit("pro.kybc.sign.uid", uid);
  await assertQuotas(DEPOSIT_QUOTAS);
  if ((await countUploadsByTarget(uid)) >= KYBC_UPLOADS_PER_ACCOUNT) throw new HttpError(409, "upload_limit", "too many KYBC pieces");
  await enforceLimit("upload.bytes.uid", uid, input.declaredSize);

  const id = newUploadId();
  const quarantineKey = quarantineObjectKey(id);
  await createUpload(id, {
    ownerUid: uid,
    purpose: "kyb",
    targetId: uid,
    declaredSize: input.declaredSize,
    declaredType: input.declaredType,
    status: "signed",
    quarantineKey,
    bucket: "private",
    checks: {},
    purgeAt: new Date(now.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS),
    createdAt: now,
    updatedAt: now,
  });
  const signed = await objects.presignPut({ bucket: "quarantine", key: quarantineKey, contentType: input.declaredType, contentLength: input.declaredSize, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
  if (actor.ip) await recordContentOp({ uid, op: "upload.create", contentRef: contentRef(id), ip: actor.ip, now });
  return { uploadId: id, url: signed.url, method: "PUT", headers: { "Content-Type": input.declaredType }, expiresAt: signed.expiresAt.toISOString() };
}

function answer(upload: UploadRecord): KybcCompleteResponse {
  if (upload.status === "ready") return { status: "ready", uploadId: upload.id };
  const reason = upload.rejectReason === "too_large" || upload.rejectReason === "bad_type" ? upload.rejectReason : "expired";
  return { status: "rejected", uploadId: upload.id, reason };
}

async function reject(objects: ObjectStore, upload: UploadRecord, reason: "too_large" | "bad_type", now: Date, size?: number): Promise<KybcCompleteResponse> {
  const marked = await transitionUpload(upload.id, ["processing"], { status: "rejected", rejectReason: reason, ...(size !== undefined ? { size } : {}) }, now);
  await objects.delete("quarantine", upload.quarantineKey).catch((error: Error) => logger.warn({ uploadId: upload.id, err: error.message }, "kybc quarantine delete failed (purge-quarantine retries)"));
  return answer(marked.upload ?? { ...upload, status: "rejected", rejectReason: reason });
}

/** Repeating it is harmless: a finished piece answers its status. */
export async function completeKybcUpload(actor: ProActor, id: string, now = new Date()): Promise<KybcCompleteResponse> {
  const upload = await getUpload(id);
  if (!upload || upload.ownerUid !== actor.auth.user.uid || upload.purpose !== "kyb") throw notFound();
  if (upload.status === "ready" || upload.status === "rejected") return answer(upload);
  const objects = store();
  const started = await transitionUpload(id, ["signed"], { status: "processing" }, now);
  if (!started.ok) {
    if (started.upload && started.upload.status !== "processing") return answer(started.upload);
    // Another complete call is processing it: the client polls.
    throw new HttpError(409, "upload_not_ready");
  }

  const head = await objects.head("quarantine", upload.quarantineKey);
  if (!head) {
    // Nothing was PUT (yet): back to signed so a later call can complete it.
    await transitionUpload(id, ["processing"], { status: "signed" }, now);
    throw new HttpError(409, "upload_not_ready", "object not uploaded");
  }
  if (head.size > upload.declaredSize) return reject(objects, upload, "too_large", now, head.size);
  const body = await objects.get("quarantine", upload.quarantineKey, { maxBytes: upload.declaredSize });
  if (!body) {
    await transitionUpload(id, ["processing"], { status: "signed" }, now);
    throw new HttpError(409, "upload_not_ready", "object not uploaded");
  }
  if (body.byteLength > upload.declaredSize) return reject(objects, upload, "too_large", now, body.byteLength);
  if (sniffKybcType(body.subarray(0, KYBC_SNIFF_BYTES)) !== upload.declaredType) return reject(objects, upload, "bad_type", now, body.byteLength);

  const finalKey = kybcObjectKey(upload.ownerUid, id);
  await objects.put("private", finalKey, body, { contentType: upload.declaredType });
  const marked = await transitionUpload(id, ["processing"], { status: "ready", finalKey, size: body.byteLength }, now);
  await objects.delete("quarantine", upload.quarantineKey).catch((error: Error) => logger.warn({ uploadId: id, err: error.message }, "kybc quarantine delete failed (purge-quarantine retries)"));
  if (!marked.ok) {
    // Deleted or expired meanwhile: its private copy goes too.
    await objects.delete("private", finalKey).catch(() => undefined);
    return answer(marked.upload ?? { ...upload, status: "rejected", rejectReason: "expired" });
  }
  return answer(marked.upload);
}
