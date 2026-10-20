import {
  DETAILS_MAX,
  DETAILS_MIN,
  RESTRICTIVE_ACTIONS,
  templatesFor,
  type DecisionAction,
  type DecisionTargetType,
  type DecisionTemplate,
  type DecisionTemplateId,
} from "@/config/decision-templates";
import type { ReportPriority } from "@/config/report-reasons";
import type { DecideRequest, LadderStep } from "@/lib/decisions/contracts";
import { canBan, nextStep } from "@/lib/decisions/ladder";
import type { AiProposal } from "@/lib/reports/admin";

// Pure side of the decision form (design D13, D14, D24): the templates offered for a target, the
// sanction the ladder proposes, what a moderator may not do (ban outside a confirmed P0), the
// request body, and how the agent's proposal is marked (followed, edited, refused).

export type StaffRole = "moderator" | "admin";
export type SanctionChoice = "none" | "warn" | "suspend_7" | "suspend_30" | "ban";

export const SANCTION_CHOICES: readonly SanctionChoice[] = ["none", "warn", "suspend_7", "suspend_30", "ban"];
export const SANCTION_LABEL: Record<SanctionChoice, string> = {
  none: "Aucune sanction du compte",
  warn: "Avertissement",
  suspend_7: "Suspension 7 jours",
  suspend_30: "Suspension 30 jours",
  ban: "Fermeture du compte",
};

/** Sanctions ladder levels (D14), as the account page and the form name them. */
export const STRIKE_LABEL = ["Aucune sanction", "Averti", "Suspendu 7 jours", "Suspendu 30 jours"] as const;

export function stepChoice(step: LadderStep): SanctionChoice {
  if (step.action === "warn") return "warn";
  if (step.action === "ban") return "ban";
  return step.durationDays === 30 ? "suspend_30" : "suspend_7";
}

export interface DecideContext {
  targetType: DecisionTargetType;
  role: StaffRole;
  /** Priorities of the target's open reports. */
  priorities: readonly ReportPriority[];
  /** The affected account's ladder level, null when unknown (no owner). */
  strikes: number | null;
}

/** The templates of a target: measures (reports founded) first, then dismissals and restorations. */
export function templateGroups(type: DecisionTargetType): { measures: DecisionTemplate[]; dismissals: DecisionTemplate[] } {
  const all = templatesFor(type);
  return { measures: all.filter((template) => template.outcome === "founded"), dismissals: all.filter((template) => template.outcome === "unfounded") };
}

/** A content measure the moderator may pair with an account sanction (P0 templates ban by themselves). */
export function offersSanction(template: DecisionTemplate, type: DecisionTargetType): boolean {
  return type !== "user" && template.outcome === "founded" && (template.action === "remove" || template.action === "restrict_visibility") && template.p0 !== true;
}

/** The ladder's proposal for a content measure: none, the next step from the account's level. */
export function defaultSanction(template: DecisionTemplate, context: Pick<DecideContext, "targetType" | "strikes">): SanctionChoice {
  if (!offersSanction(template, context.targetType) || template.defaultSanction !== "next" || context.strikes === null) return "none";
  return stepChoice(nextStep(context.strikes));
}

/** The ladder step proposed for the account (user targets: the matching template). */
export function proposedStep(strikes: number | null): SanctionChoice | null {
  return strikes === null ? null : stepChoice(nextStep(strikes));
}

/** A template the reader may apply: a ban (ban templates, P0 confirmations) needs canBan (D14). */
export function templateAllowed(template: DecisionTemplate, context: Pick<DecideContext, "role" | "priorities">): boolean {
  if (template.action !== "ban" && template.p0 !== true) return true;
  return canBan({ role: context.role, template, priorities: context.priorities });
}

export function sanctionAllowed(choice: SanctionChoice, context: Pick<DecideContext, "role">): boolean {
  return choice !== "ban" || context.role === "admin";
}

// ---- The agent's proposal (advisory, D19-D20, audit D1b-10) -----------------------------------

/** What the proposal says of the reports: founded, unfounded, or nothing usable (hold, escalate, unclear). */
export function aiDirection(ai: Pick<AiProposal, "verdict" | "action">): "founded" | "unfounded" | null {
  if (ai.verdict === "founded" || ai.verdict === "unfounded") return ai.verdict;
  if (ai.verdict) return null;
  // Older proposals without a verdict: reject = the report is founded, approve = it is not.
  return ai.action === "reject" ? "founded" : ai.action === "approve" ? "unfounded" : null;
}

/** The registry template the agent suggests (snake_case, e.g. "listing_remove_scam"), when one of this target's matches. */
export function aiTemplate(ai: Pick<AiProposal, "templateId"> | null, type: DecisionTargetType): DecisionTemplate | null {
  if (!ai?.templateId) return null;
  return templatesFor(type).find((template) => template.id.replace(/\./g, "_") === ai.templateId) ?? null;
}

const DOC_ID = /^[A-Za-z0-9]{20}$/;

/**
 * How the decision marks a pending proposal: confirmed when it goes the agent's way (its template
 * or none suggested), edited when it goes that way with another template, rejected otherwise.
 * Null when there is nothing to mark (none, already reviewed, no usable verdict).
 */
export function aiReview(ai: AiProposal | null, template: DecisionTemplate, type: DecisionTargetType): NonNullable<DecideRequest["ai"]> | null {
  if (!ai || ai.applied !== "pending" || !DOC_ID.test(ai.id)) return null;
  const direction = aiDirection(ai);
  if (!direction) return null;
  if (direction !== template.outcome) return { decisionId: ai.id, outcome: "rejected" };
  const suggested = aiTemplate(ai, type);
  return { decisionId: ai.id, outcome: suggested && suggested.id !== template.id ? "edited" : "confirmed" };
}

export const AI_REVIEW_LABEL = { confirmed: "suivie", edited: "suivie avec un autre modèle", rejected: "écartée" } as const;

// ---- The request ------------------------------------------------------------------------------

export interface DecideDraft {
  template: DecisionTemplate | null;
  details: string;
  sanction: SanctionChoice;
  manifestlyUnfounded: boolean;
}

export interface DecideProblems {
  template?: string;
  details?: string;
  sanction?: string;
}

export function decideProblems(draft: DecideDraft, context: DecideContext): DecideProblems {
  const problems: DecideProblems = {};
  const { template } = draft;
  if (!template) return { template: "Choisissez un modèle de décision." };
  if (!templateAllowed(template, context)) {
    problems.template =
      template.p0 === true
        ? "Un modérateur ne confirme un P0 que sur un signalement P0 ouvert. Demandez à un admin."
        : "Seul un admin peut fermer un compte hors confirmation d'un signalement P0.";
  }
  const details = draft.details.trim();
  if (template.detailsRequired && details.length < DETAILS_MIN) problems.details = `Ce modèle demande une précision d'au moins ${DETAILS_MIN} caractères.`;
  else if (details.length > DETAILS_MAX) problems.details = `${DETAILS_MAX} caractères au plus.`;
  if (offersSanction(template, context.targetType) && !sanctionAllowed(draft.sanction, context)) problems.sanction = "Seul un admin peut fermer un compte avec cette mesure.";
  return problems;
}

function sanctionBody(choice: SanctionChoice): DecideRequest["sanction"] {
  switch (choice) {
    case "warn":
      return { action: "warn" };
    case "suspend_7":
      return { action: "suspend_account", durationDays: 7 };
    case "suspend_30":
      return { action: "suspend_account", durationDays: 30 };
    case "ban":
      return { action: "ban" };
    default:
      return undefined;
  }
}

/** POST /api/admin/decisions body (decideSchema); the template must be set. */
export function buildDecideRequest(target: string, draft: DecideDraft & { template: DecisionTemplate }, context: DecideContext, ai: AiProposal | null): DecideRequest {
  const { template } = draft;
  const details = draft.details.trim();
  const sanction = offersSanction(template, context.targetType) ? sanctionBody(draft.sanction) : undefined;
  const review = aiReview(ai, template, context.targetType);
  return {
    target,
    templateId: template.id as DecisionTemplateId,
    ...(details ? { details } : {}),
    ...(sanction ? { sanction } : {}),
    ...(draft.manifestlyUnfounded && template.outcome === "unfounded" ? { manifestlyUnfounded: true as const } : {}),
    ...(review ? { ai: review } : {}),
  };
}

const CONFIRM: Record<DecisionTargetType, Partial<Record<DecisionAction, string>>> = {
  listing: { remove: "Retirer l'annonce", restrict_visibility: "Restreindre l'annonce", restore: "Rétablir l'annonce", no_action: "Classer sans suite" },
  message: { remove: "Masquer le message", restore: "Rétablir le message", no_action: "Classer sans suite" },
  user: { warn: "Avertir le compte", suspend_account: "Suspendre le compte", ban: "Fermer le compte", restore: "Rétablir le compte", no_action: "Classer sans suite" },
};

/** The confirm button names the measure. */
export function confirmLabel(template: DecisionTemplate, type: DecisionTargetType): string {
  return CONFIRM[type][template.action] ?? "Confirmer la décision";
}

/** Who is told, in the recap before confirming. */
export function noticeLine(template: DecisionTemplate, type: DecisionTargetType): string {
  if (RESTRICTIVE_ACTIONS.includes(template.action)) return "La personne concernée reçoit l'exposé des motifs avec le lien de recours ; chaque signalant reçoit l'issue.";
  if (template.action === "restore") return `${type === "listing" ? "Le vendeur est prévenu du rétablissement" : "Le contenu est rétabli"} ; chaque signalant reçoit l'issue.`;
  return "Chaque signalant reçoit l'issue de son signalement.";
}
