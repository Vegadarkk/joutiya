import "server-only";
import { Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import type { ReportPriority } from "@/config/report-reasons";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, reportSchema, type REPORT_STATUSES, type ReportDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { parseTargetKey, type TargetRef } from "./target-key";

// reports/{id} (design D10, §1): notices of art. 16 DSA, kept 5 years. The server is the only
// writer; every read and write is counted against the Spark quotas (`consume`). Queue order: status
// then priority then due date (index status, priority, slaDueAt); a target's reports by `target.id`
// (index target.id, status; the single-field index for the whole history).

export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const OPEN_STATUSES: readonly ReportStatus[] = ["open", "in_review"];
export const CLOSED_STATUSES: readonly ReportStatus[] = ["actioned", "dismissed"];
export const REPORT_RETENTION_YEARS = 5;
/** Reports read for one target (dedupe, strong signal, back-office view): far above any real case. */
export const TARGET_REPORTS_LIMIT = 100;

export interface ReportRecord extends ReportDoc {
  id: string;
}

const reports = () => db().collection(COLLECTIONS.reports);
export const reportRef = (id: string) => reports().doc(id);

/** A fresh document id, known before the transaction (the `report:{id}` legal hold names it). */
export function newReportId(): string {
  return reports().doc().id;
}

export function reportPurgeAt(createdAt: Date): Date {
  const purgeAt = new Date(createdAt.getTime());
  purgeAt.setUTCFullYear(purgeAt.getUTCFullYear() + REPORT_RETENTION_YEARS);
  return purgeAt;
}

export function reportFromSnapshot(snapshot: DocumentSnapshot): ReportRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = reportSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

/** Validates and creates the report inside the transaction that applies its effects. */
export function createReportTx(tx: Transaction, id: string, doc: ReportDoc): void {
  tx.create(reportRef(id), datesToTimestamps(reportSchema.parse(doc)));
  void consume("firestore.writes", 1);
}

export async function getReport(id: string): Promise<ReportRecord | null> {
  const snapshot = await reportRef(id).get();
  void consume("firestore.reads", 1);
  return reportFromSnapshot(snapshot);
}

/** Field updates outside a transaction (`hidden` after the hide, assignment). */
export async function updateReport(id: string, patch: Partial<Pick<ReportDoc, "hidden" | "strongSignal" | "assignee" | "aiDecisionId" | "status" | "ackSentAt">>, now = new Date()): Promise<void> {
  await reportRef(id).update(datesToTimestamps({ ...patch, updatedAt: now }) as Record<string, unknown>);
  void consume("firestore.writes", 1);
}

function sameType(target: TargetRef) {
  return (report: ReportRecord) => report.target.type === target.type;
}

/** Reports on a target, any status (or only `statuses`), newest first, at most TARGET_REPORTS_LIMIT. */
export async function listTargetReports(target: TargetRef, statuses?: readonly ReportStatus[]): Promise<ReportRecord[]> {
  let query = reports().where("target.id", "==", target.id);
  if (statuses) query = query.where("status", "in", [...statuses]);
  const snapshot = await query.limit(TARGET_REPORTS_LIMIT).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs
    .map(reportFromSnapshot)
    .filter((record): record is ReportRecord => record !== null)
    .filter(sameType(target))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Open and in-review reports of the target named by `key` (`targetKey()`), newest first; [] for a malformed key. */
export async function openReportsForTarget(key: string): Promise<ReportRecord[]> {
  const target = parseTargetKey(key);
  if (!target) return [];
  return listTargetReports(target, OPEN_STATUSES);
}

export interface CloseReportsInput {
  status: Extract<ReportStatus, "actioned" | "dismissed">;
  outcome: "founded" | "unfounded";
  decisionId: string;
  /** Dismissal flagged "manifestly unfounded" (art. 23): every id (true) or these ids. */
  manifestlyUnfounded?: boolean | readonly string[];
  now: Date;
}

/**
 * Closes reports inside the decision's transaction (writes only: the caller did its reads first, as
 * Firestore requires). The listing counters and legal holds are the decision's own writes (D13).
 */
export function closeReportsTx(tx: Transaction, ids: readonly string[], input: CloseReportsInput): void {
  const flagged = (id: string) =>
    input.status === "dismissed" && (input.manifestlyUnfounded === true || (Array.isArray(input.manifestlyUnfounded) && input.manifestlyUnfounded.includes(id)));
  for (const id of new Set(ids)) {
    tx.update(reportRef(id), {
      status: input.status,
      outcome: input.outcome,
      decisionId: input.decisionId,
      ...(flagged(id) ? { manifestlyUnfounded: true } : {}),
      closedAt: Timestamp.fromDate(input.now),
      updatedAt: Timestamp.fromDate(input.now),
    });
    void consume("firestore.writes", 1);
  }
}

// ---- Queue ------------------------------------------------------------------------------------

export interface QueueCursor {
  priority: ReportPriority;
  /** slaDueAt for the open queues, createdAt for the closed ones (epoch ms). */
  at: number;
  id: string;
}

export function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify([cursor.priority, cursor.at, cursor.id])).toString("base64url");
}

export function decodeCursor(value: string): QueueCursor | null {
  if (value.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [priority, at, id] = parsed as unknown[];
    if (typeof priority !== "string" || !["P0", "P1", "P2", "P3"].includes(priority)) return null;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return null;
    if (typeof id !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(id)) return null;
    return { priority: priority as ReportPriority, at, id };
  } catch {
    return null;
  }
}

export interface QueueQuery {
  status: ReportStatus;
  /** Open queues only (the closed ones have no index on priority). */
  priority?: ReportPriority;
  limit: number;
  after?: QueueCursor;
}

/**
 * One page of a queue. Open and in-review: by priority then due date (most urgent first). Actioned
 * and dismissed: newest first. One extra document is read to know whether a next page exists.
 */
export async function listQueueRecords(query: QueueQuery): Promise<{ records: ReportRecord[]; next: QueueCursor | null }> {
  const open = OPEN_STATUSES.includes(query.status);
  let ref = reports().where("status", "==", query.status);
  if (open) {
    if (query.priority) ref = ref.where("priority", "==", query.priority).orderBy("slaDueAt", "asc").orderBy("__name__", "asc");
    else ref = ref.orderBy("priority", "asc").orderBy("slaDueAt", "asc").orderBy("__name__", "asc");
  } else {
    ref = ref.orderBy("createdAt", "desc").orderBy("__name__", "desc");
  }
  if (query.after) {
    const at = Timestamp.fromMillis(query.after.at);
    if (!open) ref = ref.startAfter(at, query.after.id);
    else if (query.priority) ref = ref.startAfter(at, query.after.id);
    else ref = ref.startAfter(query.after.priority, at, query.after.id);
  }
  const snapshot = await ref.limit(query.limit + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const records = snapshot.docs.map(reportFromSnapshot).filter((record): record is ReportRecord => record !== null);
  const page = records.slice(0, query.limit);
  const last = page.at(-1);
  const next = snapshot.size > query.limit && last ? { priority: last.priority, at: (open ? last.slaDueAt : last.createdAt).getTime(), id: last.id } : null;
  return { records: page, next };
}

// ---- Legal holds of the reported documents (D10) ----------------------------------------------

export const HOLD_MAX = 50;

/** `report:{id}`, the legal hold a report puts on the reported content until its decision. */
export function reportHold(reportId: string): string {
  return `report:${reportId}`;
}

/** The holds once `hold` is added, or null when it is there already or the list is full (the purge is blocked either way). */
export function withHold(current: readonly string[] | undefined, hold: string): string[] | null {
  const list = current ?? [];
  if (list.includes(hold) || list.length >= HOLD_MAX) return null;
  return [...list, hold];
}

