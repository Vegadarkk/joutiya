import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { DECISION_TARGET_TYPES, RESTRICTIVE_ACTIONS, decisionTemplate, fillTemplateText, type DecisionAction, type DecisionTargetType } from "@/config/decision-templates";
import { audit } from "@/lib/audit";
import { getListing } from "@/lib/db/repositories/listings";
import { HttpError, notFound } from "@/lib/http/errors";
import { consume } from "@/lib/quota";
import type { ResendNoticeResponse } from "./contracts";
import type { DecisionActor } from "./decide";
import { sendDecisionNotice, type NoticeInput } from "./notify";
import { decisionRef, getDecision, getSuspension, type DecisionRecord } from "./repository";

// The statement of reasons sent again (audit D1a-08). decide() records `notifiedAt` when it
// enqueues the statement: the mail queue retries transient failures, but a degraded mail quota
// skips the mail for good (src/lib/mail/deliver.ts) and the affected user would learn of the
// measure without the statement and its appeal link. A staff member re-sends it from the stored
// decision; every re-send is audited (`decision.notify`).

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moderator's own words, quoted after the template facts in `facts` (null when the template text moved since). */
export function detailsOf(record: Pick<DecisionRecord, "templateId" | "facts" | "durationDays">): string | null {
  const template = decisionTemplate(record.templateId);
  if (!template) return null;
  const facts = fillTemplateText(template.facts.fr, { ...(record.durationDays ? { days: record.durationDays } : {}) });
  if (record.facts === facts) return null;
  return record.facts.startsWith(`${facts}\n\n`) ? record.facts.slice(facts.length + 2) : null;
}

/** End of the suspension the decision imposed: the running one it opened, else createdAt + its length. */
async function suspensionEnd(record: DecisionRecord): Promise<Date | null> {
  if (record.action !== "suspend_account") return null;
  const suspension = await getSuspension(record.affectedUid);
  if (suspension?.decisionId === record.id) return suspension.until;
  return record.durationDays ? new Date(record.createdAt.getTime() + record.durationDays * DAY_MS) : null;
}

/**
 * POST /api/admin/decisions/{id}/notify. 404 unknown decision; 409 `conflict` when the decision
 * carries no statement (restore, no_action, a phase 3 demotion) or when an authority order forbade
 * informing the user (never notified). `sent: false` when the account has no address any more.
 */
export async function resendDecisionNotice(actor: DecisionActor & { role: "moderator" | "admin" }, decisionId: string, options: { now?: Date; ip?: string } = {}): Promise<ResendNoticeResponse> {
  const now = options.now ?? new Date();
  const record = await getDecision(decisionId);
  if (!record) throw notFound();
  if (!(RESTRICTIVE_ACTIONS as readonly string[]).includes(record.action)) throw new HttpError(409, "conflict", "this decision carries no statement of reasons");
  if (record.origin === "authority_order" && !record.notifiedAt) throw new HttpError(409, "conflict", "the order forbids informing the user");
  const targetType = record.target.type as DecisionTargetType;
  if (!DECISION_TARGET_TYPES.includes(targetType)) throw new HttpError(409, "conflict", "this decision's target has no statement mail");

  const title = targetType === "listing" ? ((await getListing(record.target.id))?.title ?? null) : null;
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
