import "server-only";
import { FieldValue, Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import type { OwnerListBucket } from "@/lib/contracts/listings";
import type { ListingPhoto } from "@/lib/contracts/media";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, listingSchema, type ListingDoc, type ListingStatus } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// listings/{listingId} (§5, design §4). The server is the only writer; every read and write counts
// against the Firestore Spark quotas (`consume`). Dates: Timestamp in Firestore, Date in memory
// (staff.ts converter pattern, deep). Partial updates take `ListingFieldPatch`: `null` deletes an
// optional field, so the lifecycle stays pure (no FieldValue import outside this module).

export interface ListingRecord extends ListingDoc {
  id: string;
}

/** Tabs of "Mes annonces" -> statuses (contracts OWNER_LIST_BUCKETS). */
export const OWNER_BUCKET_STATUSES: Record<OwnerListBucket, readonly ListingStatus[]> = {
  drafts: ["draft"],
  active: ["published", "paused"],
  pending: ["pending_review"],
  ended: ["sold", "expired", "rejected", "removed"],
};

/** Statuses that occupy an `activeListings` slot (a paused listing frees its slot: Listing.errors.listing_limit). */
export const ACTIVE_STATUSES: readonly ListingStatus[] = ["published", "pending_review"];

/** A partial update: `undefined` leaves the field alone, `null` deletes an optional field. */
export type ListingFieldPatch = { [K in keyof ListingDoc]?: ListingDoc[K] | null };

export class DraftLimitError extends Error {
  constructor() {
    super("draft limit reached");
    this.name = "DraftLimitError";
  }
}

export class PhotoLimitError extends Error {
  constructor() {
    super("photo limit reached");
    this.name = "PhotoLimitError";
  }
}

export class ListingVersionError extends Error {
  constructor() {
    super("listing changed concurrently");
    this.name = "ListingVersionError";
  }
}

export const listingRef = (id: string) => db().collection(COLLECTIONS.listings).doc(id);
const listings = () => db().collection(COLLECTIONS.listings);

export function fromSnapshot(snapshot: DocumentSnapshot): ListingRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = listingSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

export function toFirestore(doc: ListingDoc): Record<string, unknown> {
  return datesToTimestamps(listingSchema.parse(doc)) as Record<string, unknown>;
}

/** Applies a field patch in memory (what Firestore will hold after `updateListing`). */
export function applyPatch<T extends ListingDoc>(listing: T, patch: ListingFieldPatch): T {
  const next: Record<string, unknown> = { ...listing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** Firestore update map of a field patch: Dates to Timestamps, `null` to a deletion. */
function toUpdate(patch: ListingFieldPatch): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    update[key] = value === null ? FieldValue.delete() : datesToTimestamps(value);
  }
  return update;
}

export async function getListing(id: string): Promise<ListingRecord | null> {
  const snapshot = await listingRef(id).get();
  void consume("firestore.reads", 1);
  return fromSnapshot(snapshot);
}

/** Several listings by id (missing or invalid ones are skipped). */
export async function getListings(ids: readonly string[]): Promise<ListingRecord[]> {
  if (ids.length === 0) return [];
  const snapshots = await db().getAll(...ids.map((id) => listingRef(id)));
  void consume("firestore.reads", snapshots.length);
  return snapshots.map(fromSnapshot).filter((record): record is ListingRecord => record !== null);
}

/**
 * Creates a draft under the per-user draft cap (D2), in one transaction: the count and the create
 * see the same state, so two parallel requests cannot both pass with 4 drafts.
 */
export async function createListing(id: string, doc: ListingDoc, options: { maxDrafts: number }): Promise<ListingRecord> {
  const data = toFirestore(doc);
  await db().runTransaction(async (tx) => {
    const drafts = await tx.get(listings().where("ownerUid", "==", doc.ownerUid).where("status", "==", "draft").count());
    void consume("firestore.reads", 1);
    if (drafts.data().count >= options.maxDrafts) throw new DraftLimitError();
    tx.create(listingRef(id), data);
  });
  void consume("firestore.writes", 1);
  return { id, ...doc };
}

/** Owner's listings of a tab, most recently updated first. */
export async function listOwnerListings(uid: string, bucket: OwnerListBucket, limit = 100): Promise<ListingRecord[]> {
  const snapshot = await listings()
    .where("ownerUid", "==", uid)
    .where("status", "in", [...OWNER_BUCKET_STATUSES[bucket]])
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is ListingRecord => record !== null);
}

/** Published listings of a seller, newest `sortAt` first (public profile; index ownerUid, status, sortAt). */
export async function listPublishedByOwner(uid: string, limit = 24): Promise<ListingRecord[]> {
  const snapshot = await listings().where("ownerUid", "==", uid).where("status", "==", "published").orderBy("sortAt", "desc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is ListingRecord => record !== null);
}

/** Listings holding an active slot (published or awaiting review). */
export async function countActive(uid: string): Promise<number> {
  const result = await listings().where("ownerUid", "==", uid).where("status", "in", [...ACTIVE_STATUSES]).count().get();
  void consume("firestore.reads", 1);
  return result.data().count;
}

export async function countDrafts(uid: string): Promise<number> {
  const result = await listings().where("ownerUid", "==", uid).where("status", "==", "draft").count().get();
  void consume("firestore.reads", 1);
  return result.data().count;
}

/**
 * Listings the owner published since `since` (the 5-per-day rule's Firestore fallback when the
 * limiter store is down; index ownerUid asc, publishedAt asc). Rolling window like the limiter.
 */
export async function countPublishedSince(uid: string, since: Date): Promise<number> {
  const result = await listings().where("ownerUid", "==", uid).where("publishedAt", ">=", Timestamp.fromDate(since)).count().get();
  void consume("firestore.reads", 1);
  return result.data().count;
}

/**
 * Owner's listings in a status set other than `exceptId` (duplicate detection: text fingerprint,
 * photo hashes). Capped: a seller has at most `activeListings` of them.
 */
export async function listOwnerListingsByStatus(uid: string, statuses: readonly ListingStatus[], limit = 50): Promise<ListingRecord[]> {
  const snapshot = await listings().where("ownerUid", "==", uid).where("status", "in", [...statuses]).limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter((record): record is ListingRecord => record !== null);
}

/** Partial update outside a transaction: `version` + 1, `updatedAt` = now. */
export async function updateListing(id: string, patch: ListingFieldPatch, now = new Date()): Promise<void> {
  await listingRef(id).update({ ...toUpdate(patch), version: FieldValue.increment(1), updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
}

/** Reads a listing inside a transaction (the write must follow in the same transaction). */
export async function getListingTx(tx: Transaction, id: string): Promise<ListingRecord | null> {
  const snapshot = await tx.get(listingRef(id));
  void consume("firestore.reads", 1);
  return fromSnapshot(snapshot);
}

/**
 * Writes a field patch inside a transaction. The caller computed `patch.version` from the record
 * it read in this transaction, so a concurrent writer makes the transaction retry, never lose data.
 */
export function updateListingTx(tx: Transaction, id: string, patch: ListingFieldPatch): void {
  tx.update(listingRef(id), toUpdate(patch));
  void consume("firestore.writes", 1);
}

/**
 * Attaches a processed photo (the pipeline's `ready` upload) at the end of the listing's photos,
 * or refreshes it in place when the id is already there, under the photo quota. Transaction:
 * two uploads completing together cannot both pass with 9 photos.
 */
export async function attachReadyPhoto(listingId: string, photo: ListingPhoto, options: { maxPhotos: number; now?: Date }): Promise<ListingRecord | null> {
  const now = options.now ?? new Date();
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, listingId);
    if (!listing) return null;
    const index = listing.photos.findIndex((item) => item.id === photo.id);
    const photos = [...listing.photos];
    if (index >= 0) photos[index] = photo;
    else {
      if (photos.length >= options.maxPhotos) throw new PhotoLimitError();
      photos.push(photo);
    }
    const patch: ListingFieldPatch = { photos, version: listing.version + 1, updatedAt: now };
    updateListingTx(tx, listingId, patch);
    return applyPatch(listing, patch);
  });
}

/** Detaches a photo from the listing (the upload document and the objects are the media pipeline's). */
export async function removePhoto(listingId: string, photoId: string, now = new Date()): Promise<ListingRecord | null> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, listingId);
    if (!listing) return null;
    const photos = listing.photos.filter((item) => item.id !== photoId);
    if (photos.length === listing.photos.length) return listing;
    const patch: ListingFieldPatch = { photos, version: listing.version + 1, updatedAt: now };
    updateListingTx(tx, listingId, patch);
    return applyPatch(listing, patch);
  });
}

/** Tests and the retention job: removes the document (the tombstone is written by the purge, not here). */
export async function deleteListingDocument(id: string): Promise<void> {
  await listingRef(id).delete();
  void consume("firestore.deletes", 1);
}
