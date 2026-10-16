import "server-only";
import { randomInt } from "node:crypto";
import { AggregateField, FieldPath, FieldValue, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { LISTING_ID_ALPHABET } from "@/lib/listings/ids";
import { consume } from "@/lib/quota";
import { COLLECTIONS, uploadSchema, type UploadDoc, type UploadStatus } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// uploads/{id} (§5): one document per signed upload, id = photo id. Written by the sign route
// (`signed`), the complete route (`processing`), the pipeline (`ready` | `rejected`) and the
// purge jobs. `size` is the quarantine object's real size (HEAD) until the upload is ready, then
// the bytes the variants occupy in the media bucket: the R2 storage gauge sums it (D15).

export interface UploadRecord extends UploadDoc {
  id: string;
}

export const UPLOAD_ID_LENGTH = 16;
/** 7 days (§5 uploads.purgeAt). */
export const UPLOAD_RETENTION_DAYS = 7;

/** 16 characters from the public-id alphabet: URL- and object-key-safe, unguessable. */
export function newUploadId(): string {
  let id = "";
  for (let i = 0; i < UPLOAD_ID_LENGTH; i += 1) id += LISTING_ID_ALPHABET[randomInt(LISTING_ID_ALPHABET.length)];
  return id;
}

/** A partial update: `null` deletes an optional field. */
export type UploadFieldPatch = { [K in keyof UploadDoc]?: UploadDoc[K] | null };

export const uploadRef = (id: string) => db().collection(COLLECTIONS.uploads).doc(id);
const uploads = () => db().collection(COLLECTIONS.uploads);

export function fromSnapshot(snapshot: DocumentSnapshot): UploadRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = uploadSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

export function toFirestore(doc: UploadDoc): Record<string, unknown> {
  return datesToTimestamps(uploadSchema.parse(doc)) as Record<string, unknown>;
}

export async function createUpload(id: string, doc: UploadDoc): Promise<UploadRecord> {
  await uploadRef(id).create(toFirestore(doc));
  void consume("firestore.writes", 1);
  return { id, ...doc };
}

/** Firestore update map of a field patch: Dates to Timestamps, `null` to a deletion. */
function toUpdate(patch: UploadFieldPatch): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    update[key] = value === null ? FieldValue.delete() : datesToTimestamps(value);
  }
  return update;
}

/** The record a patch leaves (in memory), validated: a write never makes a document unreadable. */
function applyUploadPatch(upload: UploadRecord, patch: UploadFieldPatch, now: Date): UploadRecord {
  const next: Record<string, unknown> = { ...upload };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const { id, ...doc } = { ...next, updatedAt: now } as UploadRecord;
  return { id, ...uploadSchema.parse(doc) };
}

export async function updateUpload(id: string, patch: UploadFieldPatch, now = new Date()): Promise<void> {
  await uploadRef(id).update({ ...toUpdate(patch), updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
}

export type UploadTransition = { ok: true; upload: UploadRecord } | { ok: false; upload: UploadRecord | null };

/**
 * Applies `patch` only while the upload is in one of the `from` statuses (transaction): the
 * complete route, the pipeline, DELETE and the purge race on the same document, and exactly one
 * of them wins each step. `ok: false` carries the current record (null when deleted).
 */
export async function transitionUpload(id: string, from: readonly UploadStatus[], patch: UploadFieldPatch, now = new Date()): Promise<UploadTransition> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(uploadRef(id));
    void consume("firestore.reads", 1);
    const upload = fromSnapshot(snapshot);
    if (!upload || !from.includes(upload.status)) return { ok: false, upload } as const;
    const next = applyUploadPatch(upload, patch, now);
    tx.update(uploadRef(id), { ...toUpdate(patch), updatedAt: Timestamp.fromDate(now) });
    void consume("firestore.writes", 1);
    return { ok: true, upload: next } as const;
  });
}

export async function getUpload(id: string): Promise<UploadRecord | null> {
  const snapshot = await uploadRef(id).get();
  void consume("firestore.reads", 1);
  return fromSnapshot(snapshot);
}

/** Several uploads by id, in the order asked (missing ones skipped). */
export async function getUploads(ids: readonly string[]): Promise<UploadRecord[]> {
  if (ids.length === 0) return [];
  const snapshots = await db().getAll(...ids.map((id) => uploadRef(id)));
  void consume("firestore.reads", snapshots.length);
  return snapshots.map(fromSnapshot).filter((record): record is UploadRecord => record !== null);
}

/** Every upload of a listing (wizard view: processing and rejected photos next to the ready ones). */
export async function listUploadsByTarget(targetId: string, statuses?: readonly UploadStatus[]): Promise<UploadRecord[]> {
  let query = uploads().where("targetId", "==", targetId);
  if (statuses) query = query.where("status", "in", [...statuses]);
  const snapshot = await query.get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is UploadRecord => record !== null);
}

/**
 * Uploads still in quarantine (signed, never completed, or processing stuck) created before
 * `before`: purge-quarantine deletes their objects. Index: uploads (status asc, createdAt asc).
 */
export async function listExpiredQuarantine(before: Date, limit = 200): Promise<UploadRecord[]> {
  const snapshot = await uploads().where("status", "in", ["signed", "processing"]).where("createdAt", "<", Timestamp.fromDate(before)).limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is UploadRecord => record !== null);
}

/**
 * Rejected uploads created in (`after`, `before`], oldest first: purge-quarantine deletes their
 * quarantine object once no presigned PUT can land any more. Index: uploads (status, createdAt).
 */
export async function listRejectedCreatedBetween(after: Date, before: Date, limit = 200): Promise<UploadRecord[]> {
  const snapshot = await uploads()
    .where("status", "==", "rejected")
    .where("createdAt", ">", Timestamp.fromDate(after))
    .where("createdAt", "<=", Timestamp.fromDate(before))
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is UploadRecord => record !== null);
}

/** Position in the purgeAt order (pagination of listPastPurge). */
export interface PurgeCursor {
  purgeAt: Date;
  id: string;
}

/** Uploads whose purgeAt passed, oldest first, after `cursor` (single-field index on purgeAt). */
export async function listPastPurge(before: Date, limit = 200, cursor?: PurgeCursor): Promise<UploadRecord[]> {
  let query = uploads().where("purgeAt", "<", Timestamp.fromDate(before)).orderBy("purgeAt", "asc").orderBy(FieldPath.documentId(), "asc");
  if (cursor) query = query.startAfter(Timestamp.fromDate(cursor.purgeAt), cursor.id);
  const snapshot = await query.limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is UploadRecord => record !== null);
}

const SWEEP_CURSOR_DOC = "purgeQuarantine";

/** Creation date up to which rejected uploads were swept (system/purgeQuarantine), or null. */
export async function readRejectedSweepCursor(): Promise<Date | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(SWEEP_CURSOR_DOC).get();
  void consume("firestore.reads", 1);
  const value: unknown = snapshot.get("rejectedCreatedAt");
  return value instanceof Timestamp ? value.toDate() : null;
}

export async function writeRejectedSweepCursor(createdAt: Date, now = new Date()): Promise<void> {
  await db()
    .collection(COLLECTIONS.system)
    .doc(SWEEP_CURSOR_DOC)
    .set({ rejectedCreatedAt: Timestamp.fromDate(createdAt), updatedAt: Timestamp.fromDate(now) }, { merge: true });
  void consume("firestore.writes", 1);
}

/** Bytes of every `ready` upload (nightly recount of the R2 storage gauge, D15). */
export async function sumReadyBytes(): Promise<number> {
  const result = await uploads().where("status", "==", "ready").aggregate({ bytes: AggregateField.sum("size") }).get();
  void consume("firestore.reads", 1);
  return Number(result.data().bytes ?? 0);
}

/** Tests and the retention job. */
export async function deleteUploadDocument(id: string): Promise<void> {
  await uploadRef(id).delete();
  void consume("firestore.deletes", 1);
}
