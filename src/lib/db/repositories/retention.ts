import "server-only";
import { FieldPath, Timestamp, type DocumentSnapshot, type Query, type Transaction } from "firebase-admin/firestore";
import { z } from "@/lib/zod";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, type ListingStatus } from "../schemas";
import { applyPatch, fromSnapshot, getListingTx, listingRef, updateListingTx, type ListingFieldPatch, type ListingRecord } from "./listings";
import { enqueueSearchOutboxTx } from "./search-outbox";
import { timestampsToDates } from "./timestamps";

// Time-driven listing jobs (design D16, architecture §5 "Purges sans TTL"): the expiry and
// reminder queries (index listings status asc, expiresAt asc), the scan of removed listings
// (index listings status asc, updatedAt asc), the reminder cursor
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

async function page(query: Query, field: "expiresAt" | "purgeAt" | "updatedAt", limit: number, cursor?: ListingCursor): Promise<ListingPage> {
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

/**
 * Listings in `statuses` whose updatedAt is <= before, oldest change first, after `cursor` (index
 * listings status asc, updatedAt asc): purge-quarantine's scan of newly removed listings.
 */
export function listListingsChangedBefore(statuses: readonly ListingStatus[], before: Date, limit: number, cursor?: ListingCursor): Promise<ListingPage> {
  return page(listings().where("status", "in", [...statuses]).where("updatedAt", "<=", Timestamp.fromDate(before)), "updatedAt", limit, cursor);
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

/** Journals purged by date only (no legal hold on them); auditLogs since phase 5 (D22, 5 years). */
export type JournalCollection = typeof COLLECTIONS.contentOps | typeof COLLECTIONS.revealLogs | typeof COLLECTIONS.auditLogs;

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

// ---- Phase 5 (design D22) ------------------------------------------------------------------------
// Collections purged at purgeAt with a check of their own state: conversations (12 months after the
// last activity, no legal hold, not frozen) with their messages and evidence; reports (closed),
// moderationDecisions (no open appeal) and authorityRequests (closed), 5 years; aiDecisions (12
// months, no legal hold, unless they ground a decision kept longer). The job decides on the stored
// data (dates converted, not schema-parsed: a malformed document never stalls a page), and every
// deletion re-reads the document in a transaction: a change since the query wins.

export type HeldCollection =
  | typeof COLLECTIONS.conversations
  | typeof COLLECTIONS.reports
  | typeof COLLECTIONS.moderationDecisions
  | typeof COLLECTIONS.authorityRequests
  | typeof COLLECTIONS.aiDecisions;

/** A document past purgeAt, as stored (Timestamps as Dates). */
export interface PastPurgeDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface PastPurgePage {
  docs: PastPurgeDoc[];
  /** Cursor after the last document read; undefined when the page is empty. */
  next?: ListingCursor;
  read: number;
}

/** Documents of `collection` whose purgeAt is <= now, oldest first, after `cursor` (single-field purgeAt index). */
export async function listPastPurge(collection: HeldCollection, now: Date, limit: number, cursor?: ListingCursor): Promise<PastPurgePage> {
  let query = db().collection(collection).where("purgeAt", "<=", Timestamp.fromDate(now)).orderBy("purgeAt", "asc").orderBy(FieldPath.documentId(), "asc");
  if (cursor) query = query.startAfter(Timestamp.fromDate(cursor.at), cursor.id);
  const snapshot = await query.limit(Math.min(limit, 500)).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const last = snapshot.docs[snapshot.docs.length - 1];
  const at: unknown = last?.get("purgeAt");
  return {
    docs: snapshot.docs.map((doc) => ({ id: doc.id, data: timestampsToDates(doc.data()) })),
    ...(last && at instanceof Timestamp ? { next: { at: at.toDate(), id: last.id } } : {}),
    read: snapshot.size,
  };
}

/**
 * Deletes the documents `ids` of `collection` that `purgeable` still accepts once re-read, in one
 * transaction (<= 250 ids); returns the ids deleted.
 */
export async function deleteIfPurgeable(collection: HeldCollection, ids: readonly string[], purgeable: (data: Record<string, unknown>) => boolean): Promise<string[]> {
  if (ids.length === 0) return [];
  if (ids.length > 250) throw new RangeError("deleteIfPurgeable: 250 documents per transaction at most");
  const refs = ids.map((id) => db().collection(collection).doc(id));
  const deleted = await db().runTransaction(async (tx) => {
    const snapshots = await tx.getAll(...refs);
    const gone: string[] = [];
    for (const snapshot of snapshots) {
      const data = snapshot.data();
      if (!data || !purgeable(timestampsToDates(data))) continue;
      tx.delete(snapshot.ref);
      gone.push(snapshot.id);
    }
    return gone;
  });
  void consume("firestore.reads", refs.length);
  if (deleted.length > 0) void consume("firestore.deletes", deleted.length);
  return deleted;
}

/** purgeAt of the moderation decisions `ids` that exist (an AI proposal grounding one lives as long). */
export async function readDecisionPurgeAts(ids: readonly string[]): Promise<Map<string, Date>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Date>();
  if (unique.length === 0) return out;
  const snapshots = await db().getAll(...unique.map((id) => db().collection(COLLECTIONS.moderationDecisions).doc(id)));
  void consume("firestore.reads", snapshots.length);
  for (const snapshot of snapshots) {
    const purgeAt: unknown = snapshot.get("purgeAt");
    if (snapshot.exists && purgeAt instanceof Timestamp) out.set(snapshot.id, purgeAt.toDate());
  }
  return out;
}

/** Moves an AI proposal's purgeAt (to its decision's, when the grounding was recorded without it). */
export async function setAiDecisionPurgeAt(id: string, purgeAt: Date): Promise<void> {
  await db().collection(COLLECTIONS.aiDecisions).doc(id).update({ purgeAt: Timestamp.fromDate(purgeAt) });
  void consume("firestore.writes", 1);
}

const conversationDoc = (cid: string) => db().collection(COLLECTIONS.conversations).doc(cid);

/** Deletes up to `limit` (<= 500) messages of `cid` created at or before `before`; returns how many. */
export async function deleteConversationMessages(cid: string, before: Date, limit: number): Promise<number> {
  const snapshot = await conversationDoc(cid).collection(COLLECTIONS.messages).where("createdAt", "<=", Timestamp.fromDate(before)).limit(Math.min(limit, 500)).select().get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.empty) return 0;
  const batch = db().batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  await batch.commit();
  void consume("firestore.deletes", snapshot.size);
  return snapshot.size;
}

/**
 * Deletes up to `limit` (<= 250) evidence documents of `cid` whose message is gone (evidence/{mid}
 * names its message): a message written after the purge started keeps its original text.
 * `read` tells whether the page was full.
 */
export async function deleteOrphanEvidence(cid: string, limit: number): Promise<{ deleted: number; read: number }> {
  const snapshot = await conversationDoc(cid).collection(COLLECTIONS.evidence).limit(Math.min(limit, 250)).select().get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.empty) return { deleted: 0, read: 0 };
  const messages = await db().getAll(...snapshot.docs.map((doc) => conversationDoc(cid).collection(COLLECTIONS.messages).doc(doc.id)));
  void consume("firestore.reads", messages.length);
  const orphans = snapshot.docs.filter((_, index) => !messages[index]?.exists);
  if (orphans.length > 0) {
    const batch = db().batch();
    for (const doc of orphans) batch.delete(doc.ref);
    await batch.commit();
    void consume("firestore.deletes", orphans.length);
  }
  return { deleted: orphans.length, read: snapshot.size };
}

/**
 * Deletes the conversation document once it has no message and no evidence left and `purgeable`
 * still accepts it (a message since the query moved purgeAt, a report put a hold), in one transaction.
 */
export async function deleteConversationIfEmpty(cid: string, purgeable: (data: Record<string, unknown>) => boolean): Promise<boolean> {
  const ref = conversationDoc(cid);
  const deleted = await db().runTransaction(async (tx) => {
    const [conversation, message, evidence] = await Promise.all([tx.get(ref), tx.get(ref.collection(COLLECTIONS.messages).limit(1)), tx.get(ref.collection(COLLECTIONS.evidence).limit(1))]);
    const data = conversation.data();
    if (!data || !message.empty || !evidence.empty || !purgeable(timestampsToDates(data))) return false;
    tx.delete(ref);
    return true;
  });
  void consume("firestore.reads", 3);
  if (deleted) void consume("firestore.deletes", 1);
  return deleted;
}

// userBlocks of purged accounts: a rotating scan by document id (cursor in system/retentionPurge).

const RETENTION_CURSOR_DOC = "retentionPurge";

export async function readUserBlocksCursor(): Promise<string | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(RETENTION_CURSOR_DOC).get();
  void consume("firestore.reads", 1);
  const after: unknown = snapshot.get("userBlocksAfter");
  return typeof after === "string" && after.length > 0 ? after : null;
}

export async function writeUserBlocksCursor(after: string | null, now = new Date()): Promise<void> {
  await db()
    .collection(COLLECTIONS.system)
    .doc(RETENTION_CURSOR_DOC)
    .set({ userBlocksAfter: after ?? "", updatedAt: Timestamp.fromDate(now) }, { merge: true });
  void consume("firestore.writes", 1);
}

/**
 * One page of userBlocks ids after `after` (document id order): deletes those whose account
 * (users/{uid}) no longer exists. `last` is the cursor for the next page, null at the end.
 */
export async function purgeOrphanUserBlocks(after: string | null, limit: number): Promise<{ deleted: number; read: number; last: string | null }> {
  let query = db().collection(COLLECTIONS.userBlocks).orderBy(FieldPath.documentId(), "asc");
  if (after) query = query.startAfter(after);
  const snapshot = await query.limit(Math.min(limit, 500)).select().get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.empty) return { deleted: 0, read: 0, last: null };
  const users = await db().getAll(...snapshot.docs.map((doc) => db().collection(COLLECTIONS.users).doc(doc.id)));
  void consume("firestore.reads", users.length);
  const orphans = snapshot.docs.filter((_, index) => !users[index]?.exists);
  if (orphans.length > 0) {
    const batch = db().batch();
    for (const doc of orphans) batch.delete(doc.ref);
    await batch.commit();
    void consume("firestore.deletes", orphans.length);
  }
  return { deleted: orphans.length, read: snapshot.size, last: snapshot.docs[snapshot.docs.length - 1]?.id ?? null };
}
