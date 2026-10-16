import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, listingStatsSchema, type ListingStatsDoc } from "../schemas";
import { timestampsToDates } from "./timestamps";

// listingStats/{listingId} (§5): counters kept apart from the listing (no version bump, no
// reindex). Phase 3 counts phone reveals synchronously; views, favorites and contacts arrive with
// the nightly stats-flush of later phases.

export const listingStatsRef = (listingId: string) => db().collection(COLLECTIONS.listingStats).doc(listingId);

export async function getListingStats(listingId: string): Promise<ListingStatsDoc | null> {
  const snapshot = await listingStatsRef(listingId).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = listingStatsSchema.safeParse(timestampsToDates(data));
  return parsed.success ? parsed.data : null;
}

/** +1 phone reveal; creates the document on the first reveal (transaction keeps the schema whole). */
export async function incrementPhoneReveals(listingId: string, now = new Date()): Promise<void> {
  const ref = listingStatsRef(listingId);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    void consume("firestore.reads", 1);
    if (snapshot.exists) {
      tx.update(ref, { phoneReveals: FieldValue.increment(1) });
    } else {
      const doc = listingStatsSchema.parse({ views: 0, favorites: 0, contacts: 0, phoneReveals: 1, flushedAt: now });
      tx.create(ref, { ...doc, flushedAt: Timestamp.fromDate(now) });
    }
    void consume("firestore.writes", 1);
  });
}
