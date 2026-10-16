import "server-only";
import type { Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, searchOutboxSchema, type SearchOutboxDoc } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// searchOutbox/{listingId} (§5): one entry per listing, written in the listing's transaction and
// consumed by the indexer (phase 4), which deletes it only if `version` did not move.

export const searchOutboxRef = (listingId: string) => db().collection(COLLECTIONS.searchOutbox).doc(listingId);

export function buildOutboxEntry(op: SearchOutboxDoc["op"], version: number, now = new Date()): SearchOutboxDoc {
  return searchOutboxSchema.parse({ op, version, enqueuedAt: now });
}

/** Upserts the entry inside the listing's transaction (`set`: a newer version replaces an older one). */
export function enqueueSearchOutboxTx(tx: Transaction, listingId: string, op: SearchOutboxDoc["op"], version: number, now = new Date()): void {
  tx.set(searchOutboxRef(listingId), datesToTimestamps(buildOutboxEntry(op, version, now)));
  void consume("firestore.writes", 1);
}

export async function enqueueSearchOutbox(listingId: string, op: SearchOutboxDoc["op"], version: number, now = new Date()): Promise<void> {
  await searchOutboxRef(listingId).set(datesToTimestamps(buildOutboxEntry(op, version, now)));
  void consume("firestore.writes", 1);
}

export async function getSearchOutbox(listingId: string): Promise<SearchOutboxDoc | null> {
  const snapshot = await searchOutboxRef(listingId).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = searchOutboxSchema.safeParse(timestampsToDates(data));
  return parsed.success ? parsed.data : null;
}

/** The consumer (phase 4) acknowledges an entry, only if the version it indexed is still the current one. */
export async function ackSearchOutbox(listingId: string, version: number): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(searchOutboxRef(listingId));
    void consume("firestore.reads", 1);
    if (!snapshot.exists || snapshot.get("version") !== version) return false;
    tx.delete(searchOutboxRef(listingId));
    void consume("firestore.deletes", 1);
    return true;
  });
}
