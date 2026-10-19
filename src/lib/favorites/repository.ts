import "server-only";
import { FieldPath, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, favoriteSchema, type FavoriteDoc } from "@/lib/db/schemas";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import type { FavoriteCursor } from "./cards";

// users/{uid}/favorites/{listingId} (design D17): {listingId, createdAt, listingSnapshot}. The
// document id is the listing id, so adding twice is one `create` refused by Firestore and removing
// twice one `delete` refused by its precondition: no read before either write. `listingId` repeats
// the id for retention-purge's collection-group query (src/lib/db/repositories/retention.ts).

/** A stored favorite; its `listingId` is the document id. */
export type FavoriteRecord = FavoriteDoc;

export interface FavoritePage {
  favorites: FavoriteRecord[];
  /** Cursor after the last favorite returned; absent on the last page. */
  next?: FavoriteCursor;
}

/** gRPC status codes of the Firestore client errors. */
const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

const favorites = (uid: string) => db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.favorites);

function fromSnapshot(snapshot: DocumentSnapshot): FavoriteRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  // The id stands in for a document written before `listingId` was (schemas.ts).
  const parsed = favoriteSchema.safeParse({ listingId: snapshot.id, ...timestampsToDates(data) });
  return parsed.success ? { ...parsed.data, listingId: snapshot.id } : null;
}

export async function getFavorite(uid: string, listingId: string): Promise<FavoriteRecord | null> {
  const snapshot = await favorites(uid).doc(listingId).get();
  void consume("firestore.reads", 1);
  return fromSnapshot(snapshot);
}

/** True when created, false when the listing already was a favorite. */
export async function createFavorite(uid: string, listingId: string, doc: Omit<FavoriteDoc, "listingId">): Promise<boolean> {
  const data = datesToTimestamps(favoriteSchema.parse({ ...doc, listingId }));
  try {
    await favorites(uid).doc(listingId).create(data);
    return true;
  } catch (error) {
    if (codeOf(error) === ALREADY_EXISTS) return false;
    throw error;
  } finally {
    void consume("firestore.writes", 1);
  }
}

/** True when deleted, false when it was not a favorite. */
export async function deleteFavorite(uid: string, listingId: string): Promise<boolean> {
  try {
    await favorites(uid).doc(listingId).delete({ exists: true });
    return true;
  } catch (error) {
    if (codeOf(error) === NOT_FOUND) return false;
    throw error;
  } finally {
    void consume("firestore.deletes", 1);
  }
}

/** Every favorite listing id of the account (hearts cache rebuild), ids only. */
export async function listFavoriteIds(uid: string, limit: number): Promise<string[]> {
  const snapshot = await favorites(uid).select().limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map((doc) => doc.id);
}

/** Newest first, `limit` per page, after `cursor`. Reads one document more to know whether a page follows. */
export async function listFavoritesPage(uid: string, limit: number, cursor?: FavoriteCursor): Promise<FavoritePage> {
  let query = favorites(uid).orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
  if (cursor) query = query.startAfter(Timestamp.fromDate(cursor.at), cursor.id);
  const snapshot = await query.limit(limit + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const docs = snapshot.docs.slice(0, limit);
  const last = docs[docs.length - 1];
  const at: unknown = last?.get("createdAt");
  return {
    favorites: docs.map(fromSnapshot).filter((record): record is FavoriteRecord => record !== null),
    ...(snapshot.size > limit && last && at instanceof Timestamp ? { next: { at: at.toDate(), id: last.id } } : {}),
  };
}
