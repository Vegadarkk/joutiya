import "server-only";
import { FieldPath, Timestamp, type DocumentSnapshot, type Query, type Transaction } from "firebase-admin/firestore";
import { z } from "@/lib/zod";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, type ListingStatus } from "../schemas";
import { applyPatch, fromSnapshot, getListingTx, listingRef, updateListingTx, type ListingFieldPatch, type ListingRecord } from "./listings";
import { enqueueSearchOutboxTx } from "./search-outbox";

// Time-driven listing jobs (design D16, architecture §5 "Purges sans TTL"): the expiry and
// reminder queries (index listings status asc, expiresAt asc), the reminder cursor
// (system/listingReminders), the purge of listings past purgeAt (tombstone) and the batch
// deletion of journals past purgeAt (contentOps, revealLogs: single-field purgeAt index).
// Pages carry a cursor taken from the raw snapshot, so a document that fails to parse never
// stalls a job.

/** Position in an ordered listing query (date field, then document id). */
export interface ListingCursor {
  at: Date;
  id: string;
}

export interface ListingPage {
  listings: ListingRecord[];
  /** Cursor after the last document read (parsed or not); undefined when the page is empty. */
  next?: ListingCursor;
  /** Documents read (the page is full when it equals the limit). */
  read: number;
}

const listings = () => db().collection(COLLECTIONS.listings);

async function page(query: Query, field: "expiresAt" | "purgeAt", limit: number, cursor?: ListingCursor): Promise<ListingPage> {
  let ordered = query.orderBy(field, "asc").orderBy(FieldPath.documentId(), "asc");
  if (cursor) ordered = ordered.startAfter(Timestamp.fromDate(cursor.at), cursor.id);
  const snapshot = await ordered.limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const last = snapshot.docs[snapshot.docs.length - 1];
  const at: unknown = last?.get(field);
  return {
    listings: snapshot.docs.map(fromSnapshot).filter((record): record is ListingRecord => record !== null),
    ...(last && at instanceof Timestamp ? { next: { at: at.toDate(), id: last.id } } : {}),
    read: snapshot.size,
  };
}

/** Statuses the nightly expiry moves to `expired` (a paused listing past expiry could never resume). */
export const EXPIRING_STATUSES: readonly ListingStatus[] = ["published", "paused"];

/** Published or paused listings whose expiresAt is <= now, oldest first, after `cursor`. */
export function listListingsToExpire(now: Date, limit: number, cursor?: ListingCursor): Promise<ListingPage> {
  return page(listings().where("status", "in", [...EXPIRING_STATUSES]).where("expiresAt", "<=", Timestamp.fromDate(now)), "expiresAt", limit, cursor);
}

/** Published listings with expiresAt in [from, to), oldest first, after `cursor` (reminders). */
export function listListingsExpiringBetween(from: Date, to: Date, limit: number, cursor?: ListingCursor): Promise<ListingPage> {
  const query = listings().where("status", "==", "published").where("expiresAt", ">=", Timestamp.fromDate(from)).where("expiresAt", "<", Timestamp.fromDate(to));
  return page(query, "expiresAt", limit, cursor);
}

/** Listings whose purgeAt is <= now, any status (the job decides), oldest first, after `cursor`. */
export function listListingsPastPurge(now: Date, limit: number, cursor?: ListingCursor): Promise<ListingPage> {
  return page(listings().where("purgeAt", "<=", Timestamp.fromDate(now)), "purgeAt", limit, cursor);
}

export interface TransitionWrite {
  patch: ListingFieldPatch & { version: number };
  search: "upsert" | "delete" | null;
}

/**
 * Applies a status change in one transaction: `compute` sees the listing as it is now (a renewal,
 * an edit or another run may have landed since the query) and returns the patch, or null to leave
 * it. The searchOutbox entry is written with the listing. Returns the listing after the patch, or
 * null when skipped or missing.
 */
export async function applyListingTransition(id: string, compute: (current: ListingRecord) => TransitionWrite | null, now: Date): Promise<ListingRecord | null> {
  return db().runTransaction(async (tx) => {
    const current = await getListingTx(tx, id);
    if (!current) return null;
    const write = compute(current);
    if (!write) return null;
    updateListingTx(tx, id, write.patch);
    if (write.search) enqueueSearchOutboxTx(tx, id, write.search, write.patch.version, now);
    return applyPatch(current, write.patch);
  });
}

// ---- Reminder cursor ---------------------------------------------------------------------------

const REMINDER_CURSOR_DOC = "listingReminders";

/**
 * Progress of listing-expiry-reminders: every published listing with (expiresAt, id) <= (through,
 * lastId) was reminded; with lastId null, every one with expiresAt < through.
 */
export interface ReminderCursor {
  through: Date;
  lastId: string | null;
}

export async function readReminderCursor(): Promise<ReminderCursor | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(REMINDER_CURSOR_DOC).get();
  void consume("firestore.reads", 1);
  const through: unknown = snapshot.get("through");
  const lastId: unknown = snapshot.get("lastId");
  if (!(through instanceof Timestamp)) return null;
  return { through: through.toDate(), lastId: typeof lastId === "string" && lastId.length > 0 ? lastId : null };
}

export async function writeReminderCursor(cursor: ReminderCursor, now = new Date()): Promise<void> {
  await db()
    .collection(COLLECTIONS.system)
    .doc(REMINDER_CURSOR_DOC)
    .set({ through: Timestamp.fromDate(cursor.through), lastId: cursor.lastId ?? "", updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
}

// ---- Purge ---------------------------------------------------------------------------------------

/**
 * What stays of a purged listing (architecture §5 "Fin de vie"): no text, criteria, photos or
 * owner. It does not parse as a listing, so every read answers 404 (D14), and the id is never
 * reused. `version` keeps the search outbox ordering; `updatedAt` (= purgedAt) puts the purge in
 * the next incremental backup, whose restore then writes the tombstone over the older captures.
 */
export const listingTombstoneSchema = z
  .object({ status: z.literal("purged"), categoryId: z.string().min(1).max(40).optional(), purgedAt: z.date(), version: z.number().int().min(0), updatedAt: z.date() })
  .strict();
export type ListingTombstone = z.infer<typeof listingTombstoneSchema>;

/**
 * Replaces the listing with its tombstone and queues the index deletion, in one transaction that
 * re-checks `purgeable` on the current document (a renewal or a legal hold since the query wins).
 */
export async function purgeListing(id: string, purgeable: (current: ListingRecord) => boolean, now: Date): Promise<ListingTombstone | null> {
  return db().runTransaction(async (tx: Transaction) => {
    const current = await getListingTx(tx, id);
    if (!current || !purgeable(current)) return null;
    const tombstone = listingTombstoneSchema.parse({ status: "purged", ...(current.categoryId ? { categoryId: current.categoryId } : {}), purgedAt: now, version: current.version + 1, updatedAt: now });
    tx.set(listingRef(id), { ...tombstone, purgedAt: Timestamp.fromDate(now), updatedAt: Timestamp.fromDate(now) });
    void consume("firestore.writes", 1);
    enqueueSearchOutboxTx(tx, id, "delete", tombstone.version, now);
    return tombstone;
  });
}

/** Tests: the raw document of a listing (tombstones included). */
export async function getListingDocument(id: string): Promise<DocumentSnapshot> {
  const snapshot = await listingRef(id).get();
  void consume("firestore.reads", 1);
  return snapshot;
}

/** Journals purged by date only (no legal hold on them). */
export type JournalCollection = typeof COLLECTIONS.contentOps | typeof COLLECTIONS.revealLogs;

/** Deletes up to `limit` (<= 500, one batch) documents of `collection` whose purgeAt is <= now; returns how many. */
export async function deleteJournalPastPurge(collection: JournalCollection, now: Date, limit: number): Promise<number> {
  const snapshot = await db().collection(collection).where("purgeAt", "<=", Timestamp.fromDate(now)).limit(Math.min(limit, 500)).select().get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.empty) return 0;
  const batch = db().batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  await batch.commit();
  void consume("firestore.deletes", snapshot.size);
  return snapshot.size;
}

/** purgeAt of the oldest document still past purgeAt in `collection` (backlog alert), or null. */
export async function oldestPastPurge(collection: JournalCollection, now: Date): Promise<Date | null> {
  const snapshot = await db().collection(collection).where("purgeAt", "<=", Timestamp.fromDate(now)).orderBy("purgeAt", "asc").limit(1).select("purgeAt").get();
  void consume("firestore.reads", 1);
  const value: unknown = snapshot.docs[0]?.get("purgeAt");
  return value instanceof Timestamp ? value.toDate() : null;
}
