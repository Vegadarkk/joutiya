import { decisionTemplate, fillTemplateText } from "@/config/decision-templates";
import type { AppealableDecision, DecisionView } from "./contracts";
import type { DecisionRecord } from "./repository";

// Response shapes of the decisions (dates as ISO strings). Pure: no Firestore access.

/** The moderator's own words, quoted after the template facts in `facts` (null when the template text moved since). */
export function detailsOf(record: Pick<DecisionRecord, "templateId" | "facts" | "durationDays">): string | null {
  const template = decisionTemplate(record.templateId);
  if (!template) return null;
  const facts = fillTemplateText(template.facts.fr, { ...(record.durationDays ? { days: record.durationDays } : {}) });
  if (record.facts === facts) return null;
  return record.facts.startsWith(`${facts}\n\n`) ? record.facts.slice(facts.length + 2) : null;
}

const iso = (date: Date | undefined | null): string | null => (date ? date.toISOString() : null);

/** Back-office view of a decision (D24). */
export function decisionView(record: DecisionRecord): DecisionView {
  const appeal = record.appeal;
  return {
    id: record.id,
    target: { type: record.target.type, id: record.target.id },
    affectedUid: record.affectedUid,
    action: record.action,
    durationDays: record.durationDays ?? null,
    templateId: record.templateId,
    facts: record.facts,
    ground: { type: record.ground.type, ref: record.ground.ref, explanation: record.ground.explanation },
    origin: record.origin,
    automated: { detection: record.automation.detection, decision: record.automation.decision },
    reportIds: [...record.reportIds],
    decidedBy: record.decidedBy,
    createdAt: record.createdAt.toISOString(),
    notifiedAt: iso(record.notifiedAt),
    appealDeadline: record.appealDeadline.toISOString(),
    appeal: appeal
      ? {
          status: appeal.status,
          by: appeal.by ?? null,
          text: appeal.text ?? null,
          openedAt: appeal.openedAt.toISOString(),
          slaDueAt: iso(appeal.slaDueAt),
          closedAt: iso(appeal.closedAt),
          reviewer: appeal.reviewer ?? null,
          selfReview: appeal.selfReview === true,
          note: appeal.note ?? null,
          outcomeDecisionId: appeal.outcomeDecisionId ?? null,
        }
      : null,
    aiDecisionId: record.aiDecisionId ?? null,
    supersedes: record.supersedes ?? null,
    supersededBy: record.supersededBy ?? null,
  };
}

const NOT_APPEALABLE_BY_AFFECTED: readonly string[] = ["restore", "no_action"];

export type AppealRefusal = "appeal_closed" | "appeal_exists" | "appeal_not_allowed";

/**
 * Why `by` cannot appeal this decision now (null: it can). Authority orders are appealed before the
 * issuing State's courts, not here; a superseded decision or a passed deadline closes the appeal;
 * one appeal per decision; the affected user appeals a restrictive measure, a notifier a dismissal.
 */
export function appealRefusal(record: DecisionRecord, by: "affected" | "reporter", now: Date): AppealRefusal | null {
  if (record.origin === "authority_order" || record.supersededBy || record.appealDeadline.getTime() <= now.getTime()) return "appeal_closed";
  if (record.appeal) return "appeal_exists";
  if (by === "affected" && NOT_APPEALABLE_BY_AFFECTED.includes(record.action)) return "appeal_not_allowed";
  if (by === "reporter" && !NOT_APPEALABLE_BY_AFFECTED.includes(record.action)) return "appeal_not_allowed";
  return null;
}

/** A decision as its affected user or notifier sees it (no staff ids, no other reporters). */
export function appealableView(record: DecisionRecord, by: "affected" | "reporter", now: Date): AppealableDecision {
  const appeal = record.appeal;
  return {
    decisionId: record.id,
    by,
    action: record.action,
    targetType: record.target.type,
    templateId: record.templateId,
    durationDays: record.durationDays ?? null,
    origin: record.origin,
    automated: { detection: record.automation.detection, decision: record.automation.decision },
    ground: { type: record.ground.type, ref: record.ground.ref },
    // The notifier reads the outcome of their notice, not the words written about the other user.
    details: by === "affected" ? detailsOf(record) : null,
    createdAt: record.createdAt.toISOString(),
    appealDeadline: record.appealDeadline.toISOString(),
    appealable: appealRefusal(record, by, now) === null,
    appeal: appeal ? { status: appeal.status, openedAt: appeal.openedAt.toISOString(), slaDueAt: iso(appeal.slaDueAt), closedAt: iso(appeal.closedAt), note: appeal.note ?? null } : null,
  };
}
