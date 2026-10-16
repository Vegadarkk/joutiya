import "server-only";
import type { ReportPriority } from "@/config/report-reasons";
import type { StaffContext } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { getListing } from "@/lib/db/repositories/listings";
import { listDecisionsForUser, type ModerationDecisionRecord } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { timestampsToDates } from "@/lib/db/repositories/timestamps";
import { aiDecisionSchema, COLLECTIONS, messageEvidenceSchema, moderationDecisionSchema, STRONG_SIGNALS, type AiDecisionDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/http/errors";
import { consume } from "@/lib/quota";
import type { RequestIdentity } from "@/lib/rate-limit/keys";
import { decodeCursor, encodeCursor, listQueueRecords, listTargetReports, OPEN_STATUSES, type ReportRecord, type ReportStatus } from "./repository";
import { readPrivateAccount } from "./reporter";
import { foundedShare, isAbusive, type StrongSignal } from "./rules";
import { parseTargetKey, splitMessageId, targetKey, type TargetRef } from "./target-key";
import { evidenceRef, messageRef, readConversationFacts } from "./targets";

// Back-office reads of the reports (design D24; U3 renders them): the queue by priority with the
// SLA due dates, grouped by target, and the target view with its history (reports, decisions, the
// agent's proposal, the reporters' accuracy). Staff only (the routes check requireStaff). Reporters'
// e-mail addresses never leave the server; a reported message is shown alone, with an audit entry.

export const QUEUE_LIMIT_DEFAULT = 50;
export const QUEUE_LIMIT_MAX = 100;
const EXCERPT_MAX = 200;
/** Accuracy looked up for at most this many distinct reporters of a target view. */
const REPORTERS_MAX = 20;
const DECISIONS_MAX = 20;

export type ReporterKind = "account" | "visitor" | "system" | "authority";

export interface ReportQueueItem {
  id: string;
  targetKey: string;
  target: { type: TargetRef["type"]; id: string; publicId: string | null; listingId: string | null };
  reasonId: string;
  priority: ReportPriority;
  status: ReportStatus;
  source: ReportRecord["source"];
  /** First 200 characters of the explanation. */
  excerpt: string;
  reporter: { kind: ReporterKind; trusted: boolean };
  strongSignal: StrongSignal | null;
  hidden: boolean;
  /** ISO dates. */
  slaDueAt: string;
  createdAt: string;
  closedAt: string | null;
  overdue: boolean;
  assignee: string | null;
  aiDecisionId: string | null;
}

export interface ReportQueueGroup {
  targetKey: string;
  /** Most urgent priority and earliest due date among the page's reports of this target. */
  priority: ReportPriority;
  slaDueAt: string;
  reportIds: string[];
}

export interface ReportQueueResponse {
  items: ReportQueueItem[];
  /** The page's reports grouped by target, most urgent first (one decision closes a whole group, D13). */
  groups: ReportQueueGroup[];
  /** Opaque cursor of the next page, or null. */
  next: string | null;
}

export interface ListQueueInput {
  priority?: ReportPriority;
  /** Default "open". */
  status?: ReportStatus;
  limit: number;
  /** Cursor of the previous page (`next`). */
  after?: string;
}

function reporterKind(report: ReportRecord): ReporterKind {
  if (report.source === "system") return "system";
  if (report.source === "authority") return "authority";
  return report.reporter.uid ? "account" : "visitor";
}

function toQueueItem(report: ReportRecord, now: Date): ReportQueueItem {
  const open = OPEN_STATUSES.includes(report.status);
  return {
    id: report.id,
    targetKey: targetKey(report.target),
    target: { type: report.target.type, id: report.target.id, publicId: report.target.publicId ?? null, listingId: report.target.listingId ?? null },
    reasonId: report.reasonId,
    priority: report.priority,
    status: report.status,
    source: report.source,
    excerpt: report.explanation.length > EXCERPT_MAX ? `${report.explanation.slice(0, EXCERPT_MAX - 1)}…` : report.explanation,
    reporter: { kind: reporterKind(report), trusted: report.reporter.trusted },
    strongSignal: report.strongSignal ?? null,
    hidden: report.hidden,
    slaDueAt: report.slaDueAt.toISOString(),
    createdAt: report.createdAt.toISOString(),
    closedAt: report.closedAt?.toISOString() ?? null,
    overdue: open && report.slaDueAt.getTime() < now.getTime(),
    assignee: report.assignee ?? null,
    aiDecisionId: report.aiDecisionId ?? null,
  };
}

export function groupByTarget(items: readonly ReportQueueItem[]): ReportQueueGroup[] {
  const groups = new Map<string, ReportQueueGroup>();
  for (const item of items) {
    const group = groups.get(item.targetKey);
    if (!group) {
      groups.set(item.targetKey, { targetKey: item.targetKey, priority: item.priority, slaDueAt: item.slaDueAt, reportIds: [item.id] });
      continue;
    }
    group.reportIds.push(item.id);
    if (item.priority < group.priority) group.priority = item.priority;
    if (item.slaDueAt < group.slaDueAt) group.slaDueAt = item.slaDueAt;
  }
  return [...groups.values()].sort((a, b) => (a.priority === b.priority ? a.slaDueAt.localeCompare(b.slaDueAt) : a.priority.localeCompare(b.priority)));
}

/**
 * A page of a report queue: open ones (default) by priority then due date, closed ones newest first.
 * 400 for a malformed cursor or a priority filter on a closed status (no index serves it).
 */
export async function listQueue(input: ListQueueInput, now = new Date()): Promise<ReportQueueResponse> {
  const status = input.status ?? "open";
  if (input.priority && !OPEN_STATUSES.includes(status)) throw new HttpError(400, "invalid_body", "priority filters the open queues only", { details: [{ path: "priority", code: "invalid_value" }] });
  const after = input.after ? decodeCursor(input.after) : undefined;
  if (after === null) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "after", code: "invalid_value" }] });
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), QUEUE_LIMIT_MAX);
  const { records, next } = await listQueueRecords({ status, ...(input.priority ? { priority: input.priority } : {}), limit, ...(after ? { after } : {}) });
  const items = records.map((record) => toQueueItem(record, now));
  return { items, groups: groupByTarget(items), next: next ? encodeCursor(next) : null };
}

// ---- Target view ------------------------------------------------------------------------------

export interface ReporterAccuracy {
  /** Decided reports among the last 10 kept, and the founded ones. */
  decided: number;
  founded: number;
  /** Founded share in [0, 1], null before the first decision. */
  share: number | null;
  total: number;
  /** Reports refused until this date (art. 23), ISO. */
  abusiveUntil: string | null;
  warned: boolean;
}

export interface ReportDetail extends ReportQueueItem {
  explanation: string;
  outcome: "founded" | "unfounded" | null;
  manifestlyUnfounded: boolean;
  decisionId: string | null;
  authorityRequestId: string | null;
  /** A visitor gave a name / an e-mail address (never shown: art. 16 data for the notifications only). */
  reporterContact: { name: boolean; email: boolean };
  reporterAccuracy: ReporterAccuracy | null;
}

export interface DecisionSummary {
  id: string;
  action: ModerationDecisionRecord["action"];
  templateId: string;
  origin: ModerationDecisionRecord["origin"];
  automated: boolean;
  decidedBy: string;
  reportCount: number;
  appealStatus: "open" | "upheld" | "reversed" | null;
  createdAt: string;
}

export interface OwnerSummary {
  uid: string;
  publicId: string;
  displayName: string;
  status: string;
  type: "individual" | "pro";
  createdAt: string;
  /** Sanctions ladder (D14): 0 none, 1 warned, 2 suspended 7 days, 3 suspended 30 days. */
  strikes: number;
}

export type TargetSnapshot =
  | {
      type: "listing";
      id: string;
      title: string;
      description: string;
      status: string;
      slugId: string | null;
      price: number | null;
      isDonation: boolean;
      photos: { id: string; variants: string[] | null }[];
      moderation: { state: string; score: number; flags: string[]; openReports: number; hiddenBy: { reportId: string; signal: StrongSignal; at: string } | null };
      adsEligible: boolean;
      publishedAt: string | null;
    }
  | { type: "user"; publicId: string; displayName: string; status: string }
  | {
      type: "message";
      cid: string;
      mid: string;
      listingId: string | null;
      /** As stored (URLs masked, HIDDEN_MARKER once hidden). */
      text: string;
      /** Original text kept as evidence (masked or hidden message), null when none. */
      original: string | null;
      hidden: boolean;
      createdAt: string | null;
      sender: "buyer" | "seller" | null;
    }
  | null;

export interface AiProposal {
  id: string;
  task: string;
  provider: string;
  model: string;
  action: AiDecisionDoc["output"]["action"];
  policy: string;
  severity: string;
  confidence: number;
  rationale: string;
  userMessage: string | null;
  templateId: string | null;
  applied: AiDecisionDoc["applied"];
  createdAt: string;
}

export interface ReportTargetView {
  targetKey: string;
  target: TargetRef;
  owner: OwnerSummary | null;
  snapshot: TargetSnapshot;
  /** Open and in-review reports, most urgent first. */
  open: ReportDetail[];
  /** Closed reports on this target, newest first. */
  history: ReportDetail[];
  decisions: DecisionSummary[];
  /** The newest proposal of the agent for this target (report triage, listing screen). */
  ai: AiProposal | null;
}

function accuracyOf(reporter: NonNullable<Awaited<ReturnType<typeof readPrivateAccount>>>["reporter"], now: Date): ReporterAccuracy {
  const founded = reporter.recent.filter(Boolean).length;
  return {
    decided: reporter.recent.length,
    founded,
    share: foundedShare(reporter),
    total: reporter.total,
    abusiveUntil: isAbusive(reporter, now) && reporter.abusiveUntil ? reporter.abusiveUntil.toISOString() : null,
    warned: reporter.warnedAt !== undefined,
  };
}

async function reporterAccuracies(reports: readonly ReportRecord[], now: Date): Promise<Map<string, ReporterAccuracy>> {
  const uids = [...new Set(reports.flatMap((report) => (report.reporter.uid ? [report.reporter.uid] : [])))].slice(0, REPORTERS_MAX);
  const entries = await Promise.all(uids.map(async (uid) => [uid, await readPrivateAccount(uid)] as const));
  return new Map(entries.flatMap(([uid, account]) => (account ? [[uid, accuracyOf(account.reporter, now)] as const] : [])));
}

function toDetail(report: ReportRecord, accuracy: Map<string, ReporterAccuracy>, now: Date): ReportDetail {
  return {
    ...toQueueItem(report, now),
    explanation: report.explanation,
    outcome: report.outcome ?? null,
    manifestlyUnfounded: report.manifestlyUnfounded === true,
    decisionId: report.decisionId ?? null,
    authorityRequestId: report.authorityRequestId ?? null,
    reporterContact: { name: Boolean(report.reporter.name), email: Boolean(report.reporter.email) },
    reporterAccuracy: report.reporter.uid ? (accuracy.get(report.reporter.uid) ?? null) : null,
  };
}

function toDecisionSummary(decision: ModerationDecisionRecord): DecisionSummary {
  return {
    id: decision.id,
    action: decision.action,
    templateId: decision.templateId,
    origin: decision.origin,
    automated: decision.automation.decision,
    decidedBy: decision.decidedBy,
    reportCount: decision.reportIds.length,
    appealStatus: decision.appeal?.status ?? null,
    createdAt: decision.createdAt.toISOString(),
  };
}

async function decisionsOnTarget(id: string): Promise<ModerationDecisionRecord[]> {
  const snapshot = await db().collection(COLLECTIONS.moderationDecisions).where("target.id", "==", id).limit(DECISIONS_MAX).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.flatMap((doc) => {
    const parsed = moderationDecisionSchema.safeParse(timestampsToDates(doc.data()));
    return parsed.success ? [{ id: doc.id, ...parsed.data }] : [];
  });
}

async function aiProposal(id: string | undefined): Promise<AiProposal | null> {
  if (!id) return null;
  const snapshot = await db().collection(COLLECTIONS.aiDecisions).doc(id).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = aiDecisionSchema.safeParse(timestampsToDates(data));
  if (!parsed.success) return null;
  const { output } = parsed.data;
  return {
    id: snapshot.id,
    task: parsed.data.task,
    provider: parsed.data.provider,
    model: parsed.data.model,
    action: output.action,
    policy: output.policy,
    severity: output.severity,
    confidence: output.confidence,
    rationale: output.rationale,
    userMessage: output.userMessage ?? null,
    templateId: output.templateId ?? null,
    applied: parsed.data.applied,
    createdAt: parsed.data.createdAt.toISOString(),
  };
}

async function ownerSummary(uid: string): Promise<OwnerSummary | null> {
  const [user, account] = await Promise.all([getUserRecord(uid), readPrivateAccount(uid)]);
  if (!user) return null;
  return {
    uid,
    publicId: user.publicId,
    displayName: user.displayName,
    status: user.status,
    type: user.type,
    createdAt: user.createdAt.toISOString(),
    strikes: account?.strikes.level ?? 0,
  };
}

const isSignal = (value: unknown): value is StrongSignal => typeof value === "string" && (STRONG_SIGNALS as readonly string[]).includes(value);

async function messageSnapshot(id: string, staff: StaffContext, identity: RequestIdentity | undefined, now: Date): Promise<TargetSnapshot> {
  const ids = splitMessageId(id);
  if (!ids) return null;
  const [conversation, message, evidence] = await Promise.all([readConversationFacts(ids.cid), messageRef(ids.cid, ids.mid).get(), evidenceRef(ids.cid, ids.mid).get()]);
  void consume("firestore.reads", 2);
  if (!message.exists) return null;
  const evidenceDoc = evidence.exists ? messageEvidenceSchema.safeParse(timestampsToDates(evidence.data())) : null;
  const senderUid: unknown = message.get("senderUid");
  const createdAt: unknown = message.get("createdAt");
  // D18: staff reads of conversations are journaled; this view shows the reported message only.
  await audit({
    actorUid: staff.user.uid,
    actorRole: staff.role,
    action: "message.read",
    target: { type: "message", id },
    automated: false,
    reason: "report target view",
    ...(identity ? { ip: identity.ip } : {}),
    at: now,
  });
  return {
    type: "message",
    cid: ids.cid,
    mid: ids.mid,
    listingId: conversation?.listingId ?? null,
    text: typeof message.get("text") === "string" ? (message.get("text") as string) : "",
    original: evidenceDoc?.success ? evidenceDoc.data.text : null,
    hidden: message.get("hidden") === true,
    createdAt: createdAt && typeof (createdAt as { toDate?: unknown }).toDate === "function" ? (createdAt as { toDate(): Date }).toDate().toISOString() : null,
    sender: conversation && senderUid === conversation.buyerUid ? "buyer" : conversation && senderUid === conversation.sellerUid ? "seller" : null,
  };
}

/**
 * The back-office view of a reported target (`targetKey`), or null when nothing is known about it
 * (no report, no content). The message snapshot is journaled (`message.read`).
 */
export async function reportTargetView(key: string, staff: StaffContext, identity?: RequestIdentity, now = new Date()): Promise<ReportTargetView | null> {
  const target = parseTargetKey(key);
  if (!target) return null;
  const reports = await listTargetReports(target);
  const accuracy = await reporterAccuracies(reports.filter((report) => OPEN_STATUSES.includes(report.status)), now);
  const open = reports
    .filter((report) => OPEN_STATUSES.includes(report.status))
    .sort((a, b) => (a.priority === b.priority ? a.slaDueAt.getTime() - b.slaDueAt.getTime() : a.priority.localeCompare(b.priority)))
    .map((report) => toDetail(report, accuracy, now));
  const history = reports.filter((report) => !OPEN_STATUSES.includes(report.status)).map((report) => toDetail(report, accuracy, now));

  let snapshot: TargetSnapshot = null;
  let ownerUid: string | undefined = reports[0]?.target.ownerUid;
  let listingAi: string | undefined;
  if (target.type === "listing") {
    const listing = await getListing(target.id);
    if (listing) {
      ownerUid = listing.ownerUid;
      listingAi = listing.moderation.ai?.decisionId;
      const hiddenBy = listing.moderation.hiddenBy;
      snapshot = {
        type: "listing",
        id: listing.id,
        title: listing.title,
        description: listing.description,
        status: listing.status,
        slugId: listing.slugId ?? null,
        price: listing.price,
        isDonation: listing.isDonation,
        photos: listing.photos.map((photo) => ({ id: photo.id, variants: photo.variants ? [...photo.variants] : null })),
        moderation: {
          state: listing.moderation.state,
          score: listing.moderation.score,
          flags: [...listing.moderation.flags],
          openReports: listing.moderation.openReports,
          hiddenBy: hiddenBy && isSignal(hiddenBy.signal) ? { reportId: hiddenBy.reportId, signal: hiddenBy.signal, at: hiddenBy.at.toISOString() } : null,
        },
        adsEligible: listing.adsEligible,
        publishedAt: listing.publishedAt?.toISOString() ?? null,
      };
    }
  } else if (target.type === "user") {
    ownerUid = target.id;
  } else if (target.type === "message") {
    snapshot = await messageSnapshot(target.id, staff, identity, now);
  }
  if (reports.length === 0 && snapshot === null && target.type !== "user") return null;

  const owner = ownerUid ? await ownerSummary(ownerUid) : null;
  if (target.type === "user") {
    if (!owner && reports.length === 0) return null;
    if (owner) snapshot = { type: "user", publicId: owner.publicId, displayName: owner.displayName, status: owner.status };
  }

  const decisionRecords = target.type === "user" ? await listDecisionsForUser(target.id, DECISIONS_MAX) : await decisionsOnTarget(target.id);
  const decisions = decisionRecords
    .filter((decision) => target.type === "user" || decision.target.type === target.type)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toDecisionSummary);
  const newestAi = [...reports].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).find((report) => report.aiDecisionId)?.aiDecisionId ?? listingAi;
  return { targetKey: targetKey(target), target, owner, snapshot, open, history, decisions, ai: await aiProposal(newestAi) };
}
