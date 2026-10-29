import { decisionTemplate, fillTemplateText } from "@/config/decision-templates";
import type { Locale } from "@/config/site";
import type { AppealableDecision } from "@/lib/decisions/contracts";
import { intlLocale } from "@/lib/listings/client/format";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";

// Pure helpers of the decisions page and the appeal link page (art. 17 and 20 DSA, design D13-D16):
// which decisions a member sees, where each one stands, and the statement texts in the reader's
// language. Records of the phase-3 publication check carry template ids outside the registry.

/** Phase-3 publication check: a hold while a listing is reviewed, then its approval. Not measures to show. */
export const HIDDEN_TEMPLATES: readonly string[] = ["listingPendingReview", "listingApproved", "listingChangesApproved"];

/** Phase-3 refusals, stated with a generic text (their stored facts are internal). */
export const LEGACY_TEMPLATES = ["listingRejected", "photoRejectedNsfw"] as const;
export type LegacyTemplate = (typeof LEGACY_TEMPLATES)[number];

export function isLegacyTemplate(id: string): id is LegacyTemplate {
  return (LEGACY_TEMPLATES as readonly string[]).includes(id);
}

export function visibleDecisions(items: readonly AppealableDecision[]): AppealableDecision[] {
  return items.filter((item) => !HIDDEN_TEMPLATES.includes(item.templateId));
}

/** A favorable outcome for the affected user, the only one a notifier may contest. */
export function isFavorable(action: AppealableDecision["action"]): boolean {
  return action === "restore" || action === "no_action";
}

export type AppealStatus =
  /** An appeal may be filed now. */
  | "form"
  | "open"
  | "upheld"
  | "reversed"
  | "expired"
  | "authority"
  | "superseded"
  /** Nothing to contest: the affected user's content stays or comes back. */
  | "favorable"
  /** Nothing to contest: the notice led to a measure. */
  | "reporterActioned";

/** Mirrors appealRefusal (src/lib/decisions/views.ts) from what the view carries. */
export function appealStatus(decision: AppealableDecision, now = new Date()): AppealStatus {
  if (decision.appeal) return decision.appeal.status;
  if (decision.appealable) return "form";
  if (decision.origin === "authority_order") return "authority";
  const favorable = isFavorable(decision.action);
  if (decision.by === "affected" && favorable) return "favorable";
  if (decision.by === "reporter" && !favorable) return "reporterActioned";
  if (new Date(decision.appealDeadline).getTime() <= now.getTime()) return "expired";
  return "superseded";
}

/** The tone of a decision's edge and chip. */
export function statusTone(status: AppealStatus): "neutral" | "warning" | "success" | "danger" | "info" {
  if (status === "form") return "warning";
  if (status === "open") return "info";
  if (status === "reversed" || status === "favorable") return "success";
  if (status === "upheld") return "danger";
  return "neutral";
}

export type MeasureKey = `remove.${"listing" | "message" | "upload" | "other"}` | Exclude<AppealableDecision["action"], "remove">;

/** Appeals.measure.* key and its values. */
export function measureKey(decision: Pick<AppealableDecision, "action" | "targetType" | "durationDays">): { key: MeasureKey; values?: { days: number } } {
  if (decision.action === "remove") {
    const target = decision.targetType === "listing" || decision.targetType === "message" || decision.targetType === "upload" ? decision.targetType : "other";
    return { key: `remove.${target}` };
  }
  if (decision.action === "suspend_account") return { key: "suspend_account", values: { days: decision.durationDays ?? 0 } };
  return { key: decision.action };
}

/** Template fragments ("l'annonce présente…") as sentences. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capital = trimmed.charAt(0).toLocaleUpperCase("fr") + trimmed.slice(1);
  return /[.!?…»]$/.test(capital) ? capital : `${capital}.`;
}

export interface StatementTexts {
  /** null: the facts come from Appeals.legacy.* (or there are none). */
  facts: string | null;
  legacy: LegacyTemplate | null;
  /** Why the facts break the law or the terms. */
  explanation: string | null;
}

/** Facts and explanation of the decision's template, in Arabic or French (Tarifit reads French). */
export function statementTexts(decision: Pick<AppealableDecision, "templateId" | "durationDays">, locale: string): StatementTexts {
  if (isLegacyTemplate(decision.templateId)) return { facts: null, legacy: decision.templateId, explanation: null };
  const template = decisionTemplate(decision.templateId);
  if (!template) return { facts: null, legacy: null, explanation: null };
  const lang = locale === "ar" ? "ar" : "fr";
  const days = decision.durationDays ?? undefined;
  return {
    facts: sentence(fillTemplateText(template.facts[lang], { days })),
    legacy: null,
    explanation: sentence(fillTemplateText(template.explanation[lang], { days })),
  };
}

/**
 * "19 octobre 2026", Morocco time (a decision's dates are instants). Node's and the browser's time
 * zone data can disagree on Africa/Casablanca's offset (+00 or +01), so between 23:00 and 00:00 UTC
 * they may print different days: the elements showing it suppress the hydration warning.
 */
export function formatDecisionDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "long", timeZone: moroccoTimeZone(new Date(iso).getTime()) }).format(new Date(iso));
}
