import "server-only";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, moderationDecisionSchema, type ModerationDecisionDoc } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// moderationDecisions/{id} (§5): statement of reasons (art. 17 DSA), kept 5 years. Phase 3 writes
// the automated holds and rejections of the pre-moderation; the admin queue adds its own.

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

export async function getModerationDecision(id: string): Promise<(ModerationDecisionDoc & { id: string }) | null> {
  const snapshot = await decisions().doc(id).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = moderationDecisionSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}
