import "server-only";
import { randomInt } from "node:crypto";
import { AggregateField, FieldPath, FieldValue, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import type { ListingPhoto } from "@/lib/contracts/media";
import { db } from "@/lib/firebase/admin";
import { LISTING_ID_ALPHABET } from "@/lib/listings/ids";
import { consume } from "@/lib/quota";
import { COLLECTIONS, uploadSchema, type ListingStatus, type UploadDoc, type UploadStatus } from "../schemas";
import { listingContentRef, recordContentOpTx } from "./content-ops";
import { applyPatch, getListingTx, updateListingTx, type ListingFieldPatch, type ListingRecord } from "./listings";
import { enqueueSearchOutboxTx } from "./search-outbox";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// uploads/{id} (§5): one document per signed upload, id = photo id. Written by the sign route
// (`signed`), the complete route (`processing`), the pipeline (`ready` | `rejected`) and the
// purge jobs. `size` is the quarantine object's real size (HEAD) until the upload is ready, then
// the bytes the variants occupy: the R2 storage gauge sums it (D15). `bucket` and `finalKey` say
// where the variants are: the media bucket, or the private bucket once purge-quarantine moved the
// photos of a removed listing there (`removed/listings/...`).

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
 * of them wins each step. `patch` may depend on the record read in the transaction. `ok: false`
 * carries the current record (null when deleted).
 */
export async function transitionUpload(
  id: string,
  from: readonly UploadStatus[],
  patch: UploadFieldPatch | ((current: UploadRecord) => UploadFieldPatch),
  now = new Date(),
): Promise<UploadTransition> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(uploadRef(id));
    void consume("firestore.reads", 1);
    const upload = fromSnapshot(snapshot);
    if (!upload || !from.includes(upload.status)) return { ok: false, upload } as const;
    const fields = typeof patch === "function" ? patch(upload) : patch;
    const next = applyUploadPatch(upload, fields, now);
    tx.update(uploadRef(id), { ...toUpdate(fields), updatedAt: Timestamp.fromDate(now) });
    void consume("firestore.writes", 1);
    return { ok: true, upload: next } as const;
  });
}

export interface ReadyAttachment {
  listingId: string;
  photo: ListingPhoto;
  maxPhotos: number;
  /** Listing statuses that still take this photo; any other (or no listing): `gone`. */
  targetStatuses: readonly ListingStatus[];
  /** Of those, the statuses the photo is attached to here; the others get it through the owner's PATCH. */
  attachStatuses: readonly ListingStatus[];
}

export type ReadyOutcome =
  | { ok: true; upload: UploadRecord; attached: boolean }
  /** No longer `processing` (finished by another run, deleted or expired): nothing written. */
  | { ok: false; reason: "stale"; upload: UploadRecord | null }
  /** The listing is gone or no longer takes photos: nothing written. */
  | { ok: false; reason: "gone"; upload: UploadRecord }
  /** The listing to attach to is full: nothing written. */
  | { ok: false; reason: "photo_limit"; upload: UploadRecord };

/**
 * The pipeline's last write, in one transaction with the listing: `processing` -> `ready` and, on
 * a listing in `attachStatuses`, the photo attached. Both are decided on the current documents, so
 * a draft published meanwhile never gets an unscreened photo, and a DELETE (which first moves the
 * upload out of `processing`) never leaves a photo attached without its upload.
 */
export async function markUploadReady(id: string, patch: UploadFieldPatch, attachment: ReadyAttachment, now = new Date()): Promise<ReadyOutcome> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(uploadRef(id));
    const listing = await getListingTx(tx, attachment.listingId);
    void consume("firestore.reads", 1);
    const upload = fromSnapshot(snapshot);
    if (!upload || upload.status !== "processing") return { ok: false, reason: "stale", upload } as const;
    if (!listing || !attachment.targetStatuses.includes(listing.status)) return { ok: false, reason: "gone", upload } as const;
    const index = listing.photos.findIndex((item) => item.id === id);
    const attach = index >= 0 || attachment.attachStatuses.includes(listing.status);
    if (attach && index < 0 && listing.photos.length >= attachment.maxPhotos) return { ok: false, reason: "photo_limit", upload } as const;

    const next = applyUploadPatch(upload, { ...patch, status: "ready" }, now);
    tx.update(uploadRef(id), { ...toUpdate({ ...patch, status: "ready" }), updatedAt: Timestamp.fromDate(now) });
    void consume("firestore.writes", 1);
    if (attach) {
      const photos = [...listing.photos];
      if (index >= 0) photos[index] = attachment.photo;
      else photos.push(attachment.photo);
      updateListingTx(tx, listing.id, { photos, version: listing.version + 1, updatedAt: now });
    }
    return { ok: true, upload: next, attached: attach } as const;
  });
}

/** A live listing would lose its last photo. */
export class LastPhotoError extends Error {
  constructor() {
    super("a live listing keeps at least one photo");
    this.name = "LastPhotoError";
  }
}

/** What a detach writes with the listing, decided on the listing's status as the transaction reads it. */
export interface DetachEffects {
  /** Statuses re-indexed: searchOutbox `upsert` in the same transaction. */
  searchStatuses: readonly ListingStatus[];
  /** contentOps `listing.update` entry (LCEN) in the same transaction, on a listing in `statuses`, when the IP is known. */
  contentOp?: { uid: string; ip: string; statuses: readonly ListingStatus[] };
}

const NO_DETACH_EFFECTS: DetachEffects = { searchStatuses: [] };

/**
 * Detaches a photo from its listing (transaction, with the searchOutbox and contentOps entries of
 * `effects`). Throws LastPhotoError when the listing is in `keepOneStatuses` and the photo is its
 * only one. `changed` is false when it was not attached (nothing written).
 */
export async function detachPhoto(
  listingId: string,
  photoId: string,
  keepOneStatuses: readonly ListingStatus[],
  now = new Date(),
  effects: DetachEffects = NO_DETACH_EFFECTS,
): Promise<{ listing: ListingRecord | null; changed: boolean }> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, listingId);
    if (!listing) return { listing: null, changed: false };
    const photos = listing.photos.filter((item) => item.id !== photoId);
    if (photos.length === listing.photos.length) return { listing, changed: false };
    if (photos.length === 0 && keepOneStatuses.includes(listing.status)) throw new LastPhotoError();
    const version = listing.version + 1;
    const patch: ListingFieldPatch = { photos, version, updatedAt: now };
    updateListingTx(tx, listingId, patch);
    if (effects.searchStatuses.includes(listing.status)) enqueueSearchOutboxTx(tx, listingId, "upsert", version, now);
    const log = effects.contentOp;
    if (log?.ip && log.statuses.includes(listing.status)) recordContentOpTx(tx, { uid: log.uid, op: "listing.update", contentRef: listingContentRef(listingId), ip: log.ip, now });
    return { listing: applyPatch(listing, patch), changed: true };
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

/**
 * Backstop of listUploadsByTarget: signing caps a listing at UPLOADS_PER_PHOTO_SLOT x its photo
 * limit (60 for Pro), so a page this long only happens through races or documents kept by a hold.
 */
export const UPLOADS_BY_TARGET_LIMIT = 100;

/**
 * Uploads of a listing, optionally in `statuses` (index uploads targetId asc, status asc), at most
 * `limit` (any order): the wizard view, the sign check and the retention purge.
 */
export async function listUploadsByTarget(targetId: string, statuses?: readonly UploadStatus[], limit = UPLOADS_BY_TARGET_LIMIT): Promise<UploadRecord[]> {
  let query = uploads().where("targetId", "==", targetId);
  if (statuses) query = query.where("status", "in", [...statuses]);
  const snapshot = await query.limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is UploadRecord => record !== null);
}

/** Upload documents of a listing, any status (count aggregation: one read per 1 000 entries). */
export async function countUploadsByTarget(targetId: string): Promise<number> {
  const result = await uploads().where("targetId", "==", targetId).count().get();
  const count = result.data().count;
  void consume("firestore.reads", 1 + Math.floor(count / 1000));
  return count;
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

/**
 * Progress of purge-quarantine's scan of removed listings (system/purgeQuarantine): every one
 * with (updatedAt, id) <= (at, id) had its photos moved to the private bucket, or handed to the
 * hourly document purge.
 */
export interface RetainedScanCursor {
  at: Date;
  id: string;
}

export async function readRetainedScanCursor(): Promise<RetainedScanCursor | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(SWEEP_CURSOR_DOC).get();
  void consume("firestore.reads", 1);
  const at: unknown = snapshot.get("retainedUpdatedAt");
  const id: unknown = snapshot.get("retainedId");
  return at instanceof Timestamp && typeof id === "string" && id.length > 0 ? { at: at.toDate(), id } : null;
}

export async function writeRetainedScanCursor(cursor: RetainedScanCursor, now = new Date()): Promise<void> {
  await db()
    .collection(COLLECTIONS.system)
    .doc(SWEEP_CURSOR_DOC)
    .set({ retainedUpdatedAt: Timestamp.fromDate(cursor.at), retainedId: cursor.id, updatedAt: Timestamp.fromDate(now) }, { merge: true });
  void consume("firestore.writes", 1);
}

/**
 * Bytes of every upload whose variants are stored (nightly recount of the R2 storage gauge, D15):
 * the `ready` ones and those deleted under a legal hold (`heldObjects`), wherever the variants
 * are: the media bucket, or the private bucket for a removed listing's (same account total, so a
 * move between buckets changes nothing).
 */
export async function sumStoredBytes(): Promise<number> {
  const totals = await Promise.all(
    [uploads().where("status", "==", "ready"), uploads().where("heldObjects", "==", true)].map(async (query) => {
      const result = await query.aggregate({ bytes: AggregateField.sum("size"), entries: AggregateField.count() }).get();
      // Aggregations bill one read per batch of up to 1 000 index entries (at least one).
      void consume("firestore.reads", 1 + Math.floor(Number(result.data().entries ?? 0) / 1000));
      return Number(result.data().bytes ?? 0);
    }),
  );
  return totals.reduce((sum, bytes) => sum + bytes, 0);
}

/**
 * Deletes an upload document and returns it as this call removed it, or null when it was already
 * gone. Two paths can delete the same upload at once (an owner DELETE retried or tapped twice,
 * purge-quarantine, retention-purge): the storage gauge takes back the bytes of the record returned
 * here (still `ready`, or `heldObjects`), so they come off once, by the state at deletion, not by a
 * snapshot another path has since ended or removed.
 */
export async function deleteUploadDocument(id: string): Promise<UploadRecord | null> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(uploadRef(id));
    void consume("firestore.reads", 1);
    const upload = fromSnapshot(snapshot);
    if (!upload) return null;
    tx.delete(uploadRef(id));
    void consume("firestore.deletes", 1);
    return upload;
  });
}
