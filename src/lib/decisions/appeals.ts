import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { decisionTemplate, RESTRICTIVE_ACTIONS, type DecisionTargetType } from "@/config/decision-templates";
import { audit } from "@/lib/audit";
import { listDecisionsForUser } from "@/lib/db/repositories/moderation-decisions";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { parseTargetKey } from "@/lib/reports/target-key";
import { verifyAppealToken } from "./appeal-token";
import { APPEAL_SLA_DAYS, type AppealQueueItem, type AppealQueueResponse, type AppealableDecision, type OpenAppealResponse, type ReviewAppealRequest, type ReviewAppealResponse } from "./contracts";
import { decide, type DecisionActor, type DecisionTarget } from "./decide";
import { appealProposal, markAiDecision, requestAppealReview, type AiReviewOutcome } from "./hooks";
import { appellantAddress, sendAppealOutcome, sendAppealReceived } from "./notify";
import { decisionFromSnapshot, decisionRef, decisionsCol, getDecision, getDecisionTx, getReports, type DecisionRecord, type OpenReport } from "./repository";
import { appealRefusal, appealableView } from "./views";

// Appeals (art. 20 DSA, design D16): one per decision, within 6 months, stored on the decision.
// The affected user appeals a restrictive measure (signed in, suspended accounts included, or by
// the signed link for a banned account); a notifier appeals the dismissal of their notice (signed
// in, or by the link of the outcome mail). Another moderator than the one who decided reviews it,
// or an admin (his own decisions included, audited as a self-review: owner decision, audit D1a-05):
// upheld (mail) or reversed (a new decision superseding it, see decide()). The agent's appeal_review
// proposal is marked by the outcome (D1b-08).

const DAY_MS = 24 * 60 * 60 * 1000;
export const APPEAL_QUEUE_LIMIT = 50;
export const MY_DECISIONS_LIMIT = 20;

const refusal = (code: "appeal_closed" | "appeal_exists" | "appeal_not_allowed") =>
  new HttpError(code === "appeal_not_allowed" ? 403 : 409, code);

export interface AppellantInput {
  by: "affected" | "reporter";
  /** The notifier's report (by "reporter"). */
  reportId?: string;
}

/** The report of a reporter's appeal: one of the decision's own, from a notice (not the platform's). */
function reporterReport(record: DecisionRecord, reports: readonly OpenReport[], match: (report: OpenReport) => boolean): OpenReport | null {
  return reports.find((report) => record.reportIds.includes(report.id) && report.source === "user" && match(report)) ?? null;
}

/** Writes the appeal on the decision (one per decision, re-checked in the transaction). */
async function storeAppeal(decisionId: string, appellant: AppellantInput, text: string, now: Date): Promise<{ record: DecisionRecord; slaDueAt: Date }> {
  const slaDueAt = new Date(now.getTime() + APPEAL_SLA_DAYS * DAY_MS);
  const record = await db().runTransaction(async (tx) => {
    const current = await getDecisionTx(tx, decisionId);
    if (!current) throw notFound();
    const refused = appealRefusal(current, appellant.by, now);
    if (refused) throw refusal(refused);
    tx.update(decisionRef(decisionId), {
      appeal: {
        status: "open",
        by: appellant.by,
        ...(appellant.reportId ? { reportId: appellant.reportId } : {}),
        text,
        openedAt: Timestamp.fromDate(now),
        slaDueAt: Timestamp.fromDate(slaDueAt),
      },
    });
    void consume("firestore.writes", 1);
    return current;
  });
  return { record, slaDueAt };
}

/** After the appeal is stored: acknowledgement (art. 20(4)), the agent's review proposal (D16). Never throws. */
async function afterOpen(record: DecisionRecord, appellant: AppellantInput, report: OpenReport | null, now: Date): Promise<void> {
  try {
    const to = await appellantAddress({ by: appellant.by, affectedUid: record.affectedUid, report });
    if (to) await sendAppealReceived(to, { decisionId: record.id, receivedAt: now, slaDays: APPEAL_SLA_DAYS });
  } catch (error) {
    logger.error({ decisionId: record.id, err: (error as Error).message }, "appeals: acknowledgement failed");
  }
  await requestAppealReview(record.id);
  logger.info({ decisionId: record.id, by: appellant.by }, "appeal opened");
}

function opened(record: DecisionRecord, appellant: AppellantInput, slaDueAt: Date): OpenAppealResponse {
  return { decisionId: record.id, by: appellant.by, status: "open", slaDueAt: slaDueAt.toISOString() };
}

/** POST /api/appeals: the signed-in affected user, or the signed-in author of one of the decision's reports. */
export async function openAppealAsMember(uid: string, input: { decisionId: string; text: string }, now = new Date()): Promise<OpenAppealResponse> {
  const record = await getDecision(input.decisionId);
  if (!record) throw notFound();
  let appellant: AppellantInput;
  let report: OpenReport | null = null;
  if (record.affectedUid === uid) appellant = { by: "affected" };
  else {
    report = reporterReport(record, await getReports(record.reportIds), (candidate) => candidate.reporter.uid === uid);
    if (!report) throw refusal("appeal_not_allowed");
    appellant = { by: "reporter", reportId: report.id };
  }
  const refused = appealRefusal(record, appellant.by, now);
  if (refused) throw refusal(refused);
  const { record: stored, slaDueAt } = await storeAppeal(record.id, appellant, input.text, now);
  await afterOpen(stored, appellant, report, now);
  return opened(stored, appellant, slaDueAt);
}

/** The decision a signed appeal link names, and who it is for; 404 for an invalid or expired token. */
async function fromToken(token: string, now: Date): Promise<{ record: DecisionRecord; appellant: AppellantInput; report: OpenReport | null }> {
  const verified = verifyAppealToken(token, now);
  if (!verified.ok) throw verified.reason === "expired" ? new HttpError(409, "appeal_closed") : notFound();
  const { claims } = verified;
  const record = await getDecision(claims.decisionId);
  if (!record) throw notFound();
  if (claims.by === "affected") return { record, appellant: { by: "affected" }, report: null };
  const report = claims.reportId && record.reportIds.includes(claims.reportId) ? reporterReport(record, await getReports([claims.reportId]), () => true) : null;
  if (!report) throw notFound();
  return { record, appellant: { by: "reporter", reportId: report.id }, report };
}

/** GET /api/appeals/link?token=: the decision summary the link page shows. */
export async function appealLinkView(token: string, now = new Date()): Promise<AppealableDecision> {
  const { record, appellant } = await fromToken(token, now);
  return appealableView(record, appellant.by, now);
}

/** POST /api/appeals/link: the appeal through the signed link of a decision or outcome mail. */
export async function openAppealByLink(input: { token: string; text: string }, now = new Date()): Promise<OpenAppealResponse> {
  const { record, appellant, report } = await fromToken(input.token, now);
  const refused = appealRefusal(record, appellant.by, now);
  if (refused) throw refusal(refused);
  const { record: stored, slaDueAt } = await storeAppeal(record.id, appellant, input.text, now);
  await afterOpen(stored, appellant, report, now);
  return opened(stored, appellant, slaDueAt);
}

/** GET /api/appeals: the decisions about the signed-in account (newest first), with their appeal state. */
export async function myDecisions(uid: string, now = new Date()): Promise<AppealableDecision[]> {
  const records = await listDecisionsForUser(uid, MY_DECISIONS_LIMIT);
  return records.map((record) => appealableView(record, "affected", now));
}

// ---- Review (staff) -----------------------------------------------------------------------------

interface QueueCursor {
  openedAt: number;
  id: string;
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(`${cursor.openedAt}.${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(value: string): QueueCursor | null {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const match = /^(\d{1,15})\.([A-Za-z0-9]{20})$/.exec(decoded);
  return match?.[1] && match[2] ? { openedAt: Number(match[1]), id: match[2] } : null;
}

export interface Reviewer {
  uid: string;
  role: "moderator" | "admin";
}

/** A moderator never reviews his own decision; an admin reviews every appeal (D16). */
export function canReview(record: Pick<DecisionRecord, "decidedBy">, reviewer: Reviewer): boolean {
  return reviewer.role === "admin" || record.decidedBy !== reviewer.uid;
}

/** Open appeals, oldest first (index appeal.status asc, appeal.openedAt asc). */
export async function appealQueue(reviewer: Reviewer, input: { limit?: number; after?: string } = {}, now = new Date()): Promise<AppealQueueResponse> {
  const limit = Math.min(Math.max(input.limit ?? APPEAL_QUEUE_LIMIT, 1), 100);
  let query = decisionsCol().where("appeal.status", "==", "open").orderBy("appeal.openedAt", "asc").orderBy("__name__", "asc");
  if (input.after) {
    const cursor = decodeCursor(input.after);
    if (!cursor) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "after", code: "invalid_value" }] });
    query = query.startAfter(Timestamp.fromMillis(cursor.openedAt), cursor.id);
  }
  const snapshot = await query.limit(limit + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const records = snapshot.docs.map(decisionFromSnapshot).filter((record): record is DecisionRecord => record?.appeal !== undefined);
  const page = records.slice(0, limit);
  const proposals = new Map(await Promise.all(page.map(async (record) => [record.id, await appealProposal(record.id)] as const)));
  const items: AppealQueueItem[] = page.map((record) => {
    const appeal = record.appeal as NonNullable<DecisionRecord["appeal"]>;
    return {
      decisionId: record.id,
      target: { type: record.target.type, id: record.target.id },
      action: record.action,
      templateId: record.templateId,
      by: appeal.by ?? null,
      text: appeal.text ?? "",
      openedAt: appeal.openedAt.toISOString(),
      slaDueAt: appeal.slaDueAt?.toISOString() ?? null,
      overdue: appeal.slaDueAt !== undefined && appeal.slaDueAt.getTime() < now.getTime(),
      decidedBy: record.decidedBy,
      reviewable: canReview(record, reviewer),
      aiDecisionId: proposals.get(record.id)?.id ?? null,
    };
  });
  const last = page[page.length - 1];
  const next = records.length > limit && last?.appeal ? encodeCursor({ openedAt: last.appeal.openedAt.getTime(), id: last.id }) : null;
  return { items, next };
}

/** The appeal's target as a decision target (phase 3 records target listings; shops are not decided here). */
function decisionTarget(record: DecisionRecord): DecisionTarget {
  const target = parseTargetKey(`${record.target.type}:${record.target.id}`);
  if (!target || target.type === "pro") throw new HttpError(409, "conflict", "this decision's target cannot be reviewed here");
  return { type: target.type as DecisionTargetType, id: target.id };
}

/** Upheld: the appeal closes, the decision stands. */
async function uphold(record: DecisionRecord, reviewerUid: string, note: string, now: Date, selfReview: boolean): Promise<void> {
  await db().runTransaction(async (tx) => {
    const current = await getDecisionTx(tx, record.id);
    if (!current?.appeal || current.appeal.status !== "open") throw new HttpError(409, "conflict", "the appeal is not open any more");
    tx.update(decisionRef(record.id), {
      "appeal.status": "upheld",
      "appeal.closedAt": Timestamp.fromDate(now),
      "appeal.reviewer": reviewerUid,
      ...(selfReview ? { "appeal.selfReview": true } : {}),
      "appeal.note": note,
    });
    void consume("firestore.writes", 1);
  });
}

/**
 * The agent's verdict on the appeal (approve = reverse, reject = uphold) read against the
 * reviewer's: confirmed when they agree, rejected when they do not; an "escalate"/"hold" proposal
 * took no side and stays as it is. The reviewer's own verdict (`input.ai`) wins when given.
 */
async function proposalReview(record: DecisionRecord, input: ReviewAppealRequest): Promise<{ decisionId: string; outcome: AiReviewOutcome } | null> {
  if (input.ai) return input.ai;
  const proposal = await appealProposal(record.id);
  if (!proposal) return null;
  const agent = proposal.action === "approve" ? "reversed" : proposal.action === "reject" ? "upheld" : null;
  if (!agent) return null;
  return { decisionId: proposal.id, outcome: agent === input.outcome ? "confirmed" : "rejected" };
}

/**
 * POST /api/admin/appeals/{decisionId}: the review by another moderator (403 `same_reviewer` for
 * the moderator who decided), or by an admin, his own decisions included: such a self-review is
 * recorded on the appeal and audited (`appeal.self_review`: who, when, the decision, the outcome).
 * A restrictive decision reversed: `appeal.reversed` restores the content, lifts the sanction and
 * takes a strike off. A dismissal reversed (a notifier's appeal): the measure of `templateId` is
 * taken now, and the original reports are marked founded. The agent's proposal, if any, is marked.
 */
export async function reviewAppeal(actor: DecisionActor & { role: "moderator" | "admin" }, decisionId: string, input: ReviewAppealRequest, options: { now?: Date; ip?: string } = {}): Promise<ReviewAppealResponse> {
  const now = options.now ?? new Date();
  const record = await getDecision(decisionId);
  if (!record) throw notFound();
  if (!record.appeal || record.appeal.status !== "open") throw new HttpError(409, "conflict", "no open appeal on this decision");
  if (!canReview(record, actor)) throw new HttpError(403, "same_reviewer");
  const selfReview = record.decidedBy === actor.uid;
  const ai = await proposalReview(record, input);

  let outcomeDecisionId: string | null = null;
  if (input.outcome === "upheld") {
    await uphold(record, actor.uid, input.note, now, selfReview);
    if (ai) await markAiDecision(ai.decisionId, ai.outcome, actor.uid, record.id);
  } else {
    const target = decisionTarget(record);
    const restrictive = (RESTRICTIVE_ACTIONS as readonly string[]).includes(record.action) || record.action === "demote";
    if (restrictive && input.templateId) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "templateId", code: "restrictive_decision_reversed_by_restore" }] });
    if (!restrictive && !input.templateId) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "templateId", code: "required" }] });
    const templateId = restrictive ? "appeal.reversed" : (input.templateId as string);
    const template = decisionTemplate(templateId);
    if (!template?.targets.includes(target.type)) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "templateId", code: "invalid_for_target" }] });
    // decide() links the new decision to the proposal (aiDecisionId) and marks it with that decision's id.
    const result = await decide(
      actor,
      { target, templateId, ...(input.details ? { details: input.details } : {}), ...(input.sanction ? { sanction: input.sanction } : {}), ...(ai ? { ai } : {}) },
      { now, ...(options.ip ? { ip: options.ip } : {}), reversal: { decisionId: record.id, note: input.note, selfReview }, ...(restrictive ? {} : { referenceReportIds: record.reportIds }) },
    );
    outcomeDecisionId = result.decisionId;
  }

  // The appellant's mail (art. 20(5)): the affected account, or the notifier of the appeal's report.
  try {
    const by = record.appeal.by ?? "affected";
    const report = by === "reporter" && record.appeal.reportId ? ((await getReports([record.appeal.reportId]))[0] ?? null) : null;
    const to = await appellantAddress({ by, affectedUid: record.affectedUid, report });
    if (to) await sendAppealOutcome(to, { decisionId: record.id, outcome: input.outcome, by, note: input.note, reviewedAt: now });
  } catch (error) {
    logger.error({ decisionId: record.id, err: (error as Error).message }, "appeals: outcome mail failed");
  }
  await audit({
    actorUid: actor.uid,
    actorRole: actor.role,
    action: `appeal.${input.outcome}`,
    target: { type: "decision", id: record.id },
    automated: false,
    reason: `${record.action} on ${record.target.type}${outcomeDecisionId ? `; decision ${outcomeDecisionId}` : ""}${selfReview ? "; self-review" : ""}`,
    ...(options.ip ? { ip: options.ip } : {}),
    at: now,
  });
  if (selfReview) {
    // Owner decision (audit D1a-05): an admin may review an appeal against his own decision; each
    // such review is its own audit entry (who, when, the original decision, the outcome).
    await audit({
      actorUid: actor.uid,
      actorRole: actor.role,
      action: "appeal.self_review",
      target: { type: "decision", id: record.id },
      automated: false,
      reason: `outcome ${input.outcome}; decided and reviewed by the same admin${outcomeDecisionId ? `; decision ${outcomeDecisionId}` : ""}`,
      ...(options.ip ? { ip: options.ip } : {}),
      at: now,
    });
  }
  return { decisionId: record.id, outcome: input.outcome, outcomeDecisionId };
}
