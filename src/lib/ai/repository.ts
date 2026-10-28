import "server-only";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { COLLECTIONS, aiDecisionSchema, type AiDecisionDoc } from "@/lib/db/schemas";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import type { AiTarget, AiTargetType } from "./types";

// aiDecisions/{id} (architecture §5, design D19, D22): the agent's proposals, kept 12 months, or as
// long as the decision they ground (5 years) once a moderator confirmed, edited or rejected them.
// Written by the worker only; read by the back office and the decisions lot.

export const AI_DECISION_MONTHS = 12;
export const GROUNDED_YEARS = 5;
/** Proposals compared when looking for the latest one of a target or an identical input. */
const RECENT = 10;

export interface AiDecisionRecord extends AiDecisionDoc {
  id: string;
}

export type AiDecisionInput = Omit<AiDecisionDoc, "createdAt" | "purgeAt" | "legalHold"> & { now?: Date };

const decisions = () => db().collection(COLLECTIONS.aiDecisions);

export function aiPurgeAt(createdAt: Date): Date {
  const at = new Date(createdAt.getTime());
  at.setUTCMonth(at.getUTCMonth() + AI_DECISION_MONTHS);
  return at;
}

function groundedPurgeAt(now: Date): Date {
  const at = new Date(now.getTime());
  at.setUTCFullYear(at.getUTCFullYear() + GROUNDED_YEARS);
  return at;
}

/** `{type}:{id}` of a proposal's target ("listing:abcdefgh", "report:...", "decision:..."). */
export function aiTargetKey(target: AiTarget): string {
  return `${target.type}:${target.id}`;
}

const TARGET_TYPES: readonly AiTargetType[] = ["listing", "report", "decision"];

export function parseAiTargetKey(key: string): AiTarget | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || key.length > 160) return null;
  const type = key.slice(0, separator) as AiTargetType;
  const id = key.slice(separator + 1);
  if (!TARGET_TYPES.includes(type) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return { type, id };
}

export function buildAiDecision(input: AiDecisionInput): AiDecisionDoc {
  const { now = new Date(), ...rest } = input;
  return aiDecisionSchema.parse({ ...rest, createdAt: now, purgeAt: aiPurgeAt(now), legalHold: [] });
}

/** Appends a proposal; returns its id. */
export async function createAiDecision(input: AiDecisionInput): Promise<string> {
  const ref = decisions().doc();
  await ref.create(datesToTimestamps(buildAiDecision(input)));
  void consume("firestore.writes", 1);
  return ref.id;
}

function fromData(id: string, data: unknown): AiDecisionRecord | null {
  const parsed = aiDecisionSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id, ...parsed.data } : null;
}

/** Newest proposals of a target, newest first (index target.id asc, createdAt desc). */
export async function listAiDecisions(target: AiTarget, limit = RECENT): Promise<AiDecisionRecord[]> {
  const snapshot = await decisions().where("target.id", "==", target.id).orderBy("createdAt", "desc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.flatMap((doc) => {
    const record = fromData(doc.id, doc.data());
    return record && record.target.type === target.type ? [record] : [];
  });
}

/** The newest proposal for `targetKey` ("listing:{id}", "report:{id}", "decision:{id}"), or null. */
export async function latestAiDecision(targetKey: string): Promise<AiDecisionRecord | null> {
  const target = parseAiTargetKey(targetKey);
  if (!target) return null;
  return (await listAiDecisions(target, RECENT))[0] ?? null;
}

export async function getAiDecision(id: string): Promise<AiDecisionRecord | null> {
  const snapshot = await decisions().doc(id).get();
  void consume("firestore.reads", 1);
  return snapshot.exists ? fromData(snapshot.id, snapshot.data()) : null;
}

/** handed_over: the agent took no side (escalate, needs_human) and a human decided. */
export type ReviewOutcome = "confirmed" | "edited" | "rejected" | "handed_over";

function reviewPatch(applied: ReviewOutcome, reviewedBy: string, decisionId: string | undefined, now: Date): Record<string, unknown> {
  return {
    applied,
    reviewedBy,
    ...(decisionId ? { decisionId, purgeAt: Timestamp.fromDate(groundedPurgeAt(now)) } : {}),
  };
}

/**
 * A moderator confirmed, edited or rejected the proposal (design D13). With `decisionId`, the
 * proposal grounds that decision and is kept as long (5 years). Missing id: false.
 */
export async function markAiDecision(id: string, applied: ReviewOutcome, reviewedBy: string, decisionId?: string, now = new Date()): Promise<boolean> {
  try {
    await decisions().doc(id).update(reviewPatch(applied, reviewedBy, decisionId, now));
    void consume("firestore.writes", 1);
    return true;
  } catch (error) {
    // NOT_FOUND (code 5): the proposal was purged or never existed.
    if ((error as { code?: number }).code === 5) return false;
    throw error;
  }
}

/** Same, inside the decision's transaction (the caller has read nothing of the proposal: blind update). */
export function markAiDecisionTx(tx: Transaction, id: string, applied: ReviewOutcome, reviewedBy: string, decisionId?: string, now = new Date()): void {
  tx.update(decisions().doc(id), reviewPatch(applied, reviewedBy, decisionId, now));
  void consume("firestore.writes", 1);
}

/** The agent applied its own proposal (D20), inside the transaction that took the decision. */
export function markAutoAppliedTx(tx: Transaction, id: string, decisionId: string, now = new Date()): void {
  tx.update(decisions().doc(id), { applied: "auto", decisionId, purgeAt: Timestamp.fromDate(groundedPurgeAt(now)) });
  void consume("firestore.writes", 1);
}
