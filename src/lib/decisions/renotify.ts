import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { DECISION_TARGET_TYPES, RESTRICTIVE_ACTIONS, decisionTemplate, type DecisionAction, type DecisionTargetType } from "@/config/decision-templates";
import { audit } from "@/lib/audit";
import { getListing } from "@/lib/db/repositories/listings";
import { HttpError, notFound } from "@/lib/http/errors";
import { consume } from "@/lib/quota";
import { getReview } from "@/lib/reviews/repository";
import type { ResendNoticeResponse } from "./contracts";
import type { DecisionActor } from "./decide";
import { sendDecisionNotice, type NoticeInput } from "./notify";
import { decisionRef, getDecision, getSuspension, type DecisionRecord } from "./repository";
import { detailsOf } from "./views";

// The statement of reasons sent again (audit D1a-08). decide() records `notifiedAt` when it
// enqueues the statement: the mail queue retries transient failures and the statement has the
// security priority (never skipped by the mail quota, Brevo fallback), but a failed enqueue or a
// lost address leaves the user without the statement and its appeal link (the failure is logged
// with the decision id). A staff member re-sends it from the stored decision; every re-send is
// audited (`decision.notify`).

const DAY_MS = 24 * 60 * 60 * 1000;


/** End of the suspension the decision imposed: the running one it opened, else createdAt + its length. */
async function suspensionEnd(record: DecisionRecord): Promise<Date | null> {
  if (record.action !== "suspend_account") return null;
  const suspension = await getSuspension(record.affectedUid);
  if (suspension?.decisionId === record.id) return suspension.until;
  return record.durationDays ? new Date(record.createdAt.getTime() + record.durationDays * DAY_MS) : null;
}

/**
 * POST /api/admin/decisions/{id}/notify. 404 unknown decision; 409 `conflict` when the decision
 * carries no statement (restore, no_action, a phase 3 demotion), when its template is not in the
 * decision catalogue (listing rejections and automated holds have their own mails: the statement
 * would lose its facts and ground), when an appeal reversed it (`supersededBy`: no longer in force)
 * or when an authority order forbade informing the user (never notified). `sent: false` when the
 * account has no address any more.
 */
export async function resendDecisionNotice(actor: DecisionActor & { role: "moderator" | "admin" }, decisionId: string, options: { now?: Date; ip?: string } = {}): Promise<ResendNoticeResponse> {
  const now = options.now ?? new Date();
  const record = await getDecision(decisionId);
  if (!record) throw notFound();
  if (!(RESTRICTIVE_ACTIONS as readonly string[]).includes(record.action)) throw new HttpError(409, "conflict", "this decision carries no statement of reasons");
  if (!decisionTemplate(record.templateId)) throw new HttpError(409, "conflict", "this decision's template has no statement mail");
  if (record.supersededBy) throw new HttpError(409, "conflict", "this decision was reversed on appeal");
  if (record.origin === "authority_order" && !record.notifiedAt) throw new HttpError(409, "conflict", "the order forbids informing the user");
  const targetType = record.target.type as DecisionTargetType;
  if (!DECISION_TARGET_TYPES.includes(targetType)) throw new HttpError(409, "conflict", "this decision's target has no statement mail");

  const title =
    targetType === "listing" ? ((await getListing(record.target.id))?.title ?? null) : targetType === "review" ? ((await getReview(record.target.id))?.targetName ?? null) : null;
  const notice: NoticeInput = {
    decisionId: record.id,
    templateId: record.templateId,
    action: record.action as DecisionAction,
    targetType,
    affectedUid: record.affectedUid,
    title,
    details: detailsOf(record),
    durationDays: record.durationDays ?? null,
    until: await suspensionEnd(record),
    source: record.origin,
    automation: record.automation,
    appealDeadline: record.appealDeadline,
  };
  const sent = await sendDecisionNotice(notice, { resentAt: now });
  let notifiedAt = record.notifiedAt ?? null;
  if (sent && !notifiedAt) {
    await decisionRef(record.id).update({ notifiedAt: Timestamp.fromDate(now) });
    void consume("firestore.writes", 1);
    notifiedAt = now;
  }
  await audit({
    actorUid: actor.uid,
    actorRole: actor.role,
    action: "decision.notify",
    target: { type: "decision", id: record.id },
    automated: false,
    reason: `statement of reasons re-sent (${sent ? "queued" : "no recipient"}); template ${record.templateId}; ${record.action} on ${record.target.type}`,
    ...(options.ip ? { ip: options.ip } : {}),
    at: now,
  });
  return { decisionId: record.id, sent, notifiedAt: notifiedAt?.toISOString() ?? null };
}
