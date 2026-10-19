import "server-only";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, moderationDecisionSchema, type ModerationDecisionDoc } from "../schemas";
import { fromSnapshot as listingFromSnapshot, type ListingRecord } from "./listings";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// moderationDecisions/{id} (§5): statement of reasons (art. 17 DSA), kept 5 years. Phase 3 writes
// the automated holds and rejections of the pre-moderation; the admin queue adds its own, and
// reads the listings awaiting a decision.

export const DECISION_RETENTION_YEARS = 5;
export const APPEAL_MONTHS = 6;

export type ModerationDecisionInput = Omit<ModerationDecisionDoc, "createdAt" | "purgeAt" | "appealDeadline" | "notifiedAt"> & {
  now?: Date;
  /** The seller was (or is being) notified at `now`. */
  notified?: boolean;
};

export function buildModerationDecision(input: ModerationDecisionInput): ModerationDecisionDoc {
  const { now = new Date(), notified, ...rest } = input;
  const appealDeadline = new Date(now.getTime());
  appealDeadline.setUTCMonth(appealDeadline.getUTCMonth() + APPEAL_MONTHS);
  const purgeAt = new Date(now.getTime());
  purgeAt.setUTCFullYear(purgeAt.getUTCFullYear() + DECISION_RETENTION_YEARS);
  return moderationDecisionSchema.parse({ ...rest, ...(notified ? { notifiedAt: now } : {}), appealDeadline, createdAt: now, purgeAt });
}

const decisions = () => db().collection(COLLECTIONS.moderationDecisions);

/** Appends a decision; returns its id (stored on `listing.moderation.lastDecisionId`). */
export async function recordModerationDecision(input: ModerationDecisionInput): Promise<string> {
  const ref = decisions().doc();
  await ref.create(datesToTimestamps(buildModerationDecision(input)));
  void consume("firestore.writes", 1);
  return ref.id;
}

/** Appends a decision inside the transaction that applies it; returns its id. */
export function recordModerationDecisionTx(tx: Transaction, input: ModerationDecisionInput): string {
  const ref = decisions().doc();
  tx.create(ref, datesToTimestamps(buildModerationDecision(input)));
  void consume("firestore.writes", 1);
  return ref.id;
}

export interface ModerationDecisionRecord extends ModerationDecisionDoc {
  id: string;
}

/** Decisions about an account, newest first (index affectedUid asc, createdAt desc). */
export async function listDecisionsForUser(uid: string, limit = 10): Promise<ModerationDecisionRecord[]> {
  const snapshot = await decisions().where("affectedUid", "==", uid).orderBy("createdAt", "desc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.flatMap((doc) => {
    const parsed = moderationDecisionSchema.safeParse(timestampsToDates(doc.data()));
    return parsed.success ? [{ id: doc.id, ...parsed.data }] : [];
  });
}

/** Decisions about one target, newest first (index target.id asc, createdAt desc); the agent reads a held listing's history with it (audit D1b-02). */
export async function listDecisionsForTarget(target: ModerationDecisionDoc["target"], limit = 10): Promise<ModerationDecisionRecord[]> {
  const snapshot = await decisions().where("target.id", "==", target.id).orderBy("createdAt", "desc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.flatMap((doc) => {
    const parsed = moderationDecisionSchema.safeParse(timestampsToDates(doc.data()));
    return parsed.success && parsed.data.target.type === target.type ? [{ id: doc.id, ...parsed.data }] : [];
  });
}

/**
 * Listings awaiting a moderator, least recently changed first (index listings status asc,
 * updatedAt asc): the hold, or the seller's last edit while held, dates the entry. `after` pages on.
 */
export async function listPendingReview(limit: number, after?: { updatedAt: Date; id: string }): Promise<ListingRecord[]> {
  let query = db().collection(COLLECTIONS.listings).where("status", "==", "pending_review").orderBy("updatedAt", "asc").orderBy("__name__", "asc");
  if (after) query = query.startAfter(Timestamp.fromDate(after.updatedAt), after.id);
  const snapshot = await query.limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(listingFromSnapshot).filter((record): record is ListingRecord => record !== null);
}

export async function getModerationDecision(id: string): Promise<(ModerationDecisionDoc & { id: string }) | null> {
  const snapshot = await decisions().doc(id).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = moderationDecisionSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}
