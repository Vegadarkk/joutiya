import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, quotaDailySchema, type QuotaDailyDoc } from "../schemas";

// quotaDaily/{date} (§5): one snapshot of the free-quota counters per UTC day, written by the
// quota-report job. Server only (deny-all rules); read by the owner from the console. Counted
// against the Firestore writes quota like every repository write.

const ref = (date: string) => db().collection(COLLECTIONS.quotaDaily).doc(date);

/** Writes the snapshot of `input.date` (merge: a rerun completes the document instead of replacing it). */
export async function writeQuotaDaily(input: QuotaDailyDoc): Promise<void> {
  const doc = quotaDailySchema.parse(input);
  await ref(doc.date).set({ ...doc, createdAt: Timestamp.fromDate(doc.createdAt) }, { merge: true });
  void consume("firestore.writes", 1);
}
