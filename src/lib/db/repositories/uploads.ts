import "server-only";
import { randomInt } from "node:crypto";
import { AggregateField, FieldValue, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { LISTING_ID_ALPHABET } from "@/lib/listings/ids";
import { consume } from "@/lib/quota";
import { COLLECTIONS, uploadSchema, type UploadDoc, type UploadStatus } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// uploads/{id} (§5): one document per signed upload, id = photo id. Written by the sign route
// (`signed`), the pipeline (`processing` -> `ready` | `rejected`) and the retention job.

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

export async function updateUpload(id: string, patch: UploadFieldPatch, now = new Date()): Promise<void> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    update[key] = value === null ? FieldValue.delete() : datesToTimestamps(value);
  }
  await uploadRef(id).update({ ...update, updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
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
