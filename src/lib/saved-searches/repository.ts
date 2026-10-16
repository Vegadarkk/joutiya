import "server-only";
import { FieldPath, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { sameSearch } from "@/lib/search/params";
import { COLLECTIONS, savedSearchSchema, type SavedSearchDoc } from "@/lib/db/schemas";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";

// users/{uid}/savedSearches/{autoId} (design D18): 10 per account, no duplicate (sameSearch). The
// create transaction reads the account's searches (10 documents at most), so the cap and the
// duplicate check hold under parallel requests. The alerts job (D19) pages the collection group
// `savedSearches where alert == "daily"` by document path: every search of an account is
// contiguous in that order (path users/{uid}/savedSearches/{id}).

export interface SavedSearchRecord extends SavedSearchDoc {
  id: string;
}

export interface AlertSearchRecord extends SavedSearchRecord {
  uid: string;
}

export interface DailySearchPage {
  searches: AlertSearchRecord[];
  /** Path of the last document read (parsed or not): the next page starts after it. */
  lastPath?: string;
  /** Documents read; a page shorter than the limit ends the query. */
  read: number;
}

export class SavedSearchLimitError extends Error {
  constructor() {
    super("saved search limit reached");
    this.name = "SavedSearchLimitError";
  }
}

export class SavedSearchExistsError extends Error {
  constructor(readonly id: string) {
    super("saved search exists");
    this.name = "SavedSearchExistsError";
  }
}

/** Bound of the account reads (the cap is 10; older data or a race may hold a few more). */
const ACCOUNT_READ_LIMIT = 50;

const searches = (uid: string) => db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.savedSearches);

function fromSnapshot(snapshot: DocumentSnapshot): SavedSearchRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = savedSearchSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

function toFirestore(doc: SavedSearchDoc): Record<string, unknown> {
  return datesToTimestamps(savedSearchSchema.parse(doc)) as Record<string, unknown>;
}

function isRecord(value: SavedSearchRecord | null): value is SavedSearchRecord {
  return value !== null;
}

/** The account's searches, newest first. */
export async function listSavedSearches(uid: string): Promise<SavedSearchRecord[]> {
  const snapshot = await searches(uid).orderBy("createdAt", "desc").limit(ACCOUNT_READ_LIMIT).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(fromSnapshot).filter(isRecord);
}

export async function getSavedSearch(uid: string, id: string): Promise<SavedSearchRecord | null> {
  const snapshot = await searches(uid).doc(id).get();
  void consume("firestore.reads", 1);
  return fromSnapshot(snapshot);
}

/** Creates under the cap; SavedSearchLimitError, or SavedSearchExistsError with the id of the same search. */
export async function createSavedSearch(uid: string, doc: SavedSearchDoc, max: number): Promise<SavedSearchRecord> {
  const ref = searches(uid).doc();
  const data = toFirestore(doc);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(searches(uid).limit(ACCOUNT_READ_LIMIT));
    void consume("firestore.reads", Math.max(1, snapshot.size));
    const existing = snapshot.docs.map(fromSnapshot).filter(isRecord);
    const same = existing.find((search) => sameSearch(search.params, doc.params));
    if (same) throw new SavedSearchExistsError(same.id);
    if (snapshot.size >= max) throw new SavedSearchLimitError();
    tx.create(ref, data);
  });
  void consume("firestore.writes", 1);
  return { id: ref.id, ...doc };
}

/**
 * Read-modify-write of one search: `change` returns the fields to set (null = nothing to write).
 * null when the search does not exist (or is not this account's).
 */
export async function updateSavedSearch(uid: string, id: string, change: (current: SavedSearchRecord) => Partial<SavedSearchDoc> | null): Promise<SavedSearchRecord | null> {
  const ref = searches(uid).doc(id);
  return db().runTransaction(async (tx) => {
    const current = fromSnapshot(await tx.get(ref));
    void consume("firestore.reads", 1);
    if (!current) return null;
    const patch = change(current);
    if (!patch) return current;
    const { id: _id, ...doc } = current;
    const next: SavedSearchDoc = { ...doc, ...patch };
    tx.set(ref, toFirestore(next));
    void consume("firestore.writes", 1);
    return { id, ...next };
  });
}

/** True when deleted, false when absent. */
export async function deleteSavedSearch(uid: string, id: string): Promise<boolean> {
  try {
    await searches(uid).doc(id).delete({ exists: true });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === 5) return false;
    throw error;
  } finally {
    void consume("firestore.deletes", 1);
  }
}

/** Unsubscribe (D20): alert "none" on one search, or on every search of the account ("*"). Returns the count changed. */
export async function disableAlerts(uid: string, target: string, now = new Date()): Promise<number> {
  if (target !== "*") {
    let changed = 0;
    await updateSavedSearch(uid, target, (current) => {
      if (current.alert === "none") return null;
      changed = 1;
      return { alert: "none", updatedAt: now };
    });
    return changed;
  }
  const snapshot = await searches(uid).where("alert", "==", "daily").limit(ACCOUNT_READ_LIMIT).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.empty) return 0;
  const batch = db().batch();
  for (const doc of snapshot.docs) batch.update(doc.ref, { alert: "none", updatedAt: Timestamp.fromDate(now) });
  await batch.commit();
  void consume("firestore.writes", snapshot.size);
  return snapshot.size;
}

// ---- Alerts job (D19) -------------------------------------------------------------------------

/** Document path just after every search of `uid` (cursor at an account boundary). */
export function accountEndPath(uid: string): string {
  return `${COLLECTIONS.users}/${uid}/${COLLECTIONS.savedSearches}/`;
}

/** Account of a search path users/{uid}/savedSearches/{id}. */
function uidOf(snapshot: DocumentSnapshot): string | undefined {
  return snapshot.ref.parent.parent?.id;
}

/**
 * Searches with a daily alert, in document path order, after `afterPath` and up to `endAtPath`
 * (both optional), `limit` per page.
 */
export async function listDailySearches(options: { afterPath?: string; endAtPath?: string; limit: number }): Promise<DailySearchPage> {
  let query = db().collectionGroup(COLLECTIONS.savedSearches).where("alert", "==", "daily").orderBy(FieldPath.documentId(), "asc");
  if (options.afterPath) query = query.startAfter(db().doc(options.afterPath));
  if (options.endAtPath) query = query.endAt(db().doc(options.endAtPath));
  const snapshot = await query.limit(options.limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const result: AlertSearchRecord[] = [];
  for (const doc of snapshot.docs) {
    const uid = uidOf(doc);
    const record = fromSnapshot(doc);
    if (uid && record && doc.ref.parent.parent?.parent.id === COLLECTIONS.users) result.push({ ...record, uid });
  }
  const last = snapshot.docs[snapshot.docs.length - 1];
  return { searches: result, ...(last ? { lastPath: last.ref.path } : {}), read: snapshot.size };
}

/** After a digest: each search moves its cursor to the newest listing sent. */
export async function markSearchesNotified(updates: { uid: string; id: string; lastNotifiedSortAt: number }[], at: Date): Promise<void> {
  if (updates.length === 0) return;
  const batch = db().batch();
  for (const update of updates) {
    batch.update(searches(update.uid).doc(update.id), { lastNotifiedSortAt: update.lastNotifiedSortAt, lastAlertAt: Timestamp.fromDate(at) });
  }
  await batch.commit();
  void consume("firestore.writes", updates.length);
}

const ALERTS_CURSOR_DOC = "savedSearchAlerts";

/** Account after which the next run starts (null = from the first one). */
export async function readAlertsCursor(): Promise<string | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(ALERTS_CURSOR_DOC).get();
  void consume("firestore.reads", 1);
  const after: unknown = snapshot.get("afterUid");
  return typeof after === "string" && after.length > 0 ? after : null;
}

export async function writeAlertsCursor(afterUid: string | null, report: Record<string, number | boolean>, now = new Date()): Promise<void> {
  await db()
    .collection(COLLECTIONS.system)
    .doc(ALERTS_CURSOR_DOC)
    .set({ afterUid: afterUid ?? "", ...report, updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
}
