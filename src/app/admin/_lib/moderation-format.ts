import { decisionTemplate } from "@/config/decision-templates";
import { reportReason, SLA_MS, type ReportPriority } from "@/config/report-reasons";
import type { AuthorityRequestView, DecisionView } from "@/lib/decisions/contracts";

// French wording and time arithmetic of the moderation back office (design D12, D24), client-safe:
// the server pages and the client islands (live SLA timers) share it. The staff work in Morocco.

export const TIME_ZONE = "Africa/Casablanca";
export const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: TIME_ZONE });
export const dateOnly = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: TIME_ZONE });

export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : "");
export const formatDate = (iso: string | null | undefined) => (iso ? dateOnly.format(new Date(iso)) : "");

export const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

export const TARGET_LABEL: Record<string, string> = { listing: "Annonce", user: "Compte", message: "Message", pro: "Boutique", conversation: "Conversation" };

/** Badge tone of a priority: P0 alarm red, P1 ochre, P2 green, P3 quiet. */
export const PRIORITY_TONE: Record<ReportPriority, "danger" | "warning" | "pro" | "neutral"> = { P0: "danger", P1: "warning", P2: "pro", P3: "neutral" };
/** Edge colour of a queue row: red, gold, green, grey. */
export const PRIORITY_EDGE: Record<ReportPriority, string> = { P0: "before:bg-danger", P1: "before:bg-featured", P2: "before:bg-structure", P3: "before:bg-border-strong" };
export const PRIORITY_DELAY: Record<ReportPriority, string> = { P0: "1 heure", P1: "24 heures", P2: "72 heures", P3: "7 jours" };

export const ACTION_LABEL: Record<DecisionView["action"], string> = {
  remove: "Retrait",
  restrict_visibility: "Visibilité restreinte",
  restore: "Rétablissement",
  no_action: "Aucune mesure",
  warn: "Avertissement",
  suspend_account: "Suspension du compte",
  ban: "Fermeture du compte",
  demote: "Rétrogradation",
};

export const REPORTER_LABEL = { account: "Membre", visitor: "Visiteur", system: "Système", authority: "Autorité" } as const;
export const SIGNAL_LABEL: Record<string, string> = {
  trusted: "Signalant fiable",
  multi: "Plusieurs signalants",
  auto: "Contrôle automatique",
  authority: "Autorité",
  decision: "Décision de modération",
};
export const ORIGIN_LABEL: Record<DecisionView["origin"], string> = { notice: "Sur signalement", own_initiative: "D'initiative", authority_order: "Injonction d'une autorité" };
export const APPEAL_STATUS_LABEL = { open: "Recours ouvert", upheld: "Recours rejeté, décision maintenue", reversed: "Décision annulée sur recours" } as const;
export const ACCOUNT_STATUS_LABEL: Record<string, string> = { active: "Actif", restricted: "Restreint", suspended: "Suspendu", banned: "Fermé (banni)", closed: "Clos par son titulaire" };

export const COUNTRY_LABEL: Record<AuthorityRequestView["country"], string> = { FR: "France", MA: "Maroc", EU: "Union européenne", other: "Autre" };
export const KIND_LABEL: Record<AuthorityRequestView["kind"], string> = {
  removal_order: "Injonction de retrait",
  data_request: "Demande de données",
  preservation: "Demande de conservation",
  other: "Autre demande",
};
export const AUTHORITY_STATUS_LABEL: Record<AuthorityRequestView["status"], string> = { open: "Ouverte", answered: "Répondue", closed: "Close" };

/** Phase 3 pre-moderation records (src/lib/listings/moderation-actions.ts) outside the registry. */
const LEGACY_TEMPLATES: Record<string, string> = {
  listingRejected: "Refus avant publication",
  listingApproved: "Validation avant publication",
  listingChangesApproved: "Modification validée",
  listingPendingReview: "Mise en attente avant publication",
  photoRejectedNsfw: "Photo refusée (nudité)",
};

export function templateLabel(id: string): string {
  return decisionTemplate(id)?.label ?? LEGACY_TEMPLATES[id] ?? id;
}

export function reasonLabel(id: string): string {
  return reportReason(id)?.label.fr ?? id;
}

/** Back-office page of a target key (`{type}:{id}`; a message id holds a slash, hence the query string). */
export function targetHref(key: string): string {
  return `/signalements/cible?cle=${encodeURIComponent(key)}`;
}

/** Where a decision's target is examined: its target view (accounts: the account page). */
export function decisionTargetHref(target: { type: string; id: string }): string {
  return target.type === "user" ? `/comptes/${encodeURIComponent(target.id)}` : targetHref(`${target.type}:${target.id}`);
}

const MINUTE = 60_000;

/** "moins d'1 min", "42 min", "3 h 05", "2 j 4 h" (rounded down: a timer never promises more time than is left). */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / MINUTE);
  if (minutes < 1) return "moins d'1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} j` : `${days} j ${restHours} h`;
}

export interface SlaState {
  overdue: boolean;
  /** danger: past due; warning: less than a quarter of the delay left; neutral otherwise. */
  tone: "danger" | "warning" | "neutral";
  label: string;
  remainingMs: number;
}

/** Where a due date stands at `now`, for a delay of `windowMs` (the priority's SLA, 14 days for an appeal). */
export function slaState(dueAt: string, now: Date, windowMs: number): SlaState {
  const remainingMs = Date.parse(dueAt) - now.getTime();
  if (remainingMs < 0) return { overdue: true, tone: "danger", label: `En retard de ${formatSpan(remainingMs)}`, remainingMs };
  return { overdue: false, tone: remainingMs < windowMs / 4 ? "warning" : "neutral", label: `Reste ${formatSpan(remainingMs)}`, remainingMs };
}

export const prioritySla = (priority: ReportPriority) => SLA_MS[priority];

/** Urgency order of the queue: past due first, then by priority, then by due date (D12, D24). */
export function orderByUrgency<T extends { priority: ReportPriority; slaDueAt: string }>(groups: readonly T[], now: Date): T[] {
  const time = now.getTime();
  return [...groups].sort((a, b) => {
    const aLate = Date.parse(a.slaDueAt) < time;
    const bLate = Date.parse(b.slaDueAt) < time;
    if (aLate !== bLate) return aLate ? -1 : 1;
    if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
    return Date.parse(a.slaDueAt) - Date.parse(b.slaDueAt);
  });
}
