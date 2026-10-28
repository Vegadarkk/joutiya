import "server-only";
import { Timestamp, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import type { Locale } from "@/config/site";
import { buildModerationDecision, type ModerationDecisionInput } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import {
  COLLECTIONS,
  moderationDecisionSchema,
  reportSchema,
  suspensionSchema,
  userPrivateSchema,
  type ModerationDecisionDoc,
  type ReportDoc,
  type SuspensionDoc,
  type UserPrivateDoc,
} from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import type { TargetRef } from "@/lib/reports/target-key";

// Firestore access of the decisions lot (design D13-D17): moderationDecisions written with a known
// id inside the decision's transaction, the target's open reports read inside it (a report that
// lands meanwhile retries the transaction instead of staying open), suspensions/{uid}, the user
// documents a sanction changes, and the account a mail goes to. Every read and write is counted.

export interface DecisionRecord extends ModerationDecisionDoc {
  id: string;
}

export interface OpenReport extends ReportDoc {
  id: string;
}

const OPEN = ["open", "in_review"];
/** Reports one decision closes at most (far above any real case; one transaction). */
export const DECISION_REPORTS_MAX = 100;

export const decisionsCol = () => db().collection(COLLECTIONS.moderationDecisions);
export const decisionRef = (id: string) => decisionsCol().doc(id);
export const reportsCol = () => db().collection(COLLECTIONS.reports);
export const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);
export const privateRef = (uid: string) => userRef(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);
export const suspensionRef = (uid: string) => db().collection(COLLECTIONS.suspensions).doc(uid);
export const conversationRef = (cid: string) => db().collection(COLLECTIONS.conversations).doc(cid);
export const messageRef = (cid: string, mid: string) => conversationRef(cid).collection(COLLECTIONS.messages).doc(mid);

export function decisionFromSnapshot(snapshot: DocumentSnapshot): DecisionRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = moderationDecisionSchema.safeParse(timestampsToDates(data));
  if (!parsed.success) {
    logger.warn({ id: snapshot.id, issues: parsed.error.issues.length }, "decisions: document does not match its schema");
    return null;
  }
  return { id: snapshot.id, ...parsed.data };
}

export async function getDecision(id: string): Promise<DecisionRecord | null> {
  const snapshot = await decisionRef(id).get();
  void consume("firestore.reads", 1);
  return decisionFromSnapshot(snapshot);
}

export async function getDecisionTx(tx: Transaction, id: string): Promise<DecisionRecord | null> {
  const snapshot = await tx.get(decisionRef(id));
  void consume("firestore.reads", 1);
  return decisionFromSnapshot(snapshot);
}

/** Creates a decision with a known id inside the transaction that applies it. */
export function createDecisionTx(tx: Transaction, ref: DocumentReference, input: ModerationDecisionInput): ModerationDecisionDoc {
  const doc = buildModerationDecision(input);
  tx.create(ref, datesToTimestamps(doc));
  void consume("firestore.writes", 1);
  return doc;
}

export function reportFromSnapshot(snapshot: DocumentSnapshot): OpenReport | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = reportSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

/** Open and in-review reports of a target, read inside the decision's transaction. */
export async function openReportsTx(tx: Transaction, target: TargetRef): Promise<OpenReport[]> {
  const snapshot = await tx.get(reportsCol().where("target.id", "==", target.id).where("status", "in", OPEN).limit(DECISION_REPORTS_MAX));
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs
    .map(reportFromSnapshot)
    .filter((report): report is OpenReport => report !== null && report.target.type === target.type)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Reports by id (a decision's reportIds, at most 100), missing ones skipped. */
export async function getReports(ids: readonly string[]): Promise<OpenReport[]> {
  const unique = [...new Set(ids)].slice(0, DECISION_REPORTS_MAX);
  if (unique.length === 0) return [];
  const snapshots = await db().getAll(...unique.map((id) => reportsCol().doc(id)));
  void consume("firestore.reads", snapshots.length);
  return snapshots.map(reportFromSnapshot).filter((report): report is OpenReport => report !== null);
}

/** Reports (any status) on the messages of a conversation: `target.id` in [`{cid}/`, `{cid}0`). */
export async function reportsOnConversation(cid: string, limit = 50): Promise<OpenReport[]> {
  const snapshot = await reportsCol()
    .where("target.id", ">=", `${cid}/`)
    .where("target.id", "<", `${cid}0`)
    .limit(limit)
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(reportFromSnapshot).filter((report): report is OpenReport => report !== null && report.target.type === "message");
}

export function privateFromSnapshot(snapshot: DocumentSnapshot): UserPrivateDoc | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = userPrivateSchema.safeParse(timestampsToDates(data));
  return parsed.success ? parsed.data : null;
}

export async function getPrivate(uid: string): Promise<UserPrivateDoc | null> {
  const snapshot = await privateRef(uid).get();
  void consume("firestore.reads", 1);
  return privateFromSnapshot(snapshot);
}

export function suspensionFromSnapshot(snapshot: DocumentSnapshot): SuspensionDoc | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = suspensionSchema.safeParse(timestampsToDates(data));
  return parsed.success ? parsed.data : null;
}

export async function getSuspension(uid: string): Promise<SuspensionDoc | null> {
  const snapshot = await suspensionRef(uid).get();
  void consume("firestore.reads", 1);
  return suspensionFromSnapshot(snapshot);
}

/** Suspensions ended at `now` (lift-suspensions), oldest end first (single-field index on `until`). */
export async function listDueSuspensions(now: Date, limit: number): Promise<{ uid: string; suspension: SuspensionDoc }[]> {
  const snapshot = await db().collection(COLLECTIONS.suspensions).where("until", "<=", Timestamp.fromDate(now)).orderBy("until", "asc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.flatMap((doc) => {
    const suspension = suspensionFromSnapshot(doc);
    return suspension ? [{ uid: doc.id, suspension }] : [];
  });
}

/** Holds without the `report:{id}` holds of these reports (null when none of them is there). */
export function withoutReportHolds(holds: readonly string[] | undefined, reportIds: readonly string[]): string[] | null {
  const list = holds ?? [];
  const drop = new Set(reportIds.map((id) => `report:${id}`));
  const kept = list.filter((hold) => !drop.has(hold));
  return kept.length === list.length ? null : kept;
}

export interface AccountRecipient {
  email: string;
  locale: Locale;
  displayName: string;
  status: UserRecord["status"];
}

/**
 * Where a statement of reasons goes: the account's address, locale and name. Banned accounts are
 * included (art. 17: the ban itself is notified, with the signed appeal link); closed ones are not.
 */
export async function accountRecipient(uid: string): Promise<AccountRecipient | null> {
  const [user, account] = await Promise.all([getUserRecord(uid), getPrivate(uid)]);
  if (!user || !account?.email || user.status === "closed") return null;
  return { email: account.email, locale: user.locale, displayName: user.displayName, status: user.status };
}

export function iso(date: Date | undefined | null): string | null {
  return date ? date.toISOString() : null;
}
