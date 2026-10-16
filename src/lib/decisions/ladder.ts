import type { DecisionTemplate, SanctionAction, SuspensionDays } from "@/config/decision-templates";
import type { ReportPriority } from "@/config/report-reasons";
import type { LadderStep } from "./contracts";

// Sanctions ladder (AF §7 step 6, design D14), pure: warn (level 1) -> suspension 7 days (2) ->
// 30 days (3) -> ban. The back office proposes the next step; the moderator may pick another. A
// moderator bans only when the decision confirms a P0 report he handles (a P0 template closing an
// open P0 report); an admin always. A reversal on appeal takes one level off.

export type StrikeLevel = 0 | 1 | 2 | 3;
export const MAX_LEVEL: StrikeLevel = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Sanction {
  action: SanctionAction;
  /** Suspensions only. */
  durationDays?: SuspensionDays;
}

/** The step the back office proposes for an account at `level`. */
export function nextStep(level: number): LadderStep {
  if (level <= 0) return { action: "warn", durationDays: null };
  if (level === 1) return { action: "suspend_account", durationDays: 7 };
  if (level === 2) return { action: "suspend_account", durationDays: 30 };
  return { action: "ban", durationDays: null };
}

/** Level a sanction brings the account to (never lower than it was). */
export function levelAfter(current: number, sanction: Sanction): StrikeLevel {
  const step = sanction.action === "warn" ? 1 : sanction.action === "ban" ? 3 : sanction.durationDays === 30 ? 3 : 2;
  return clampLevel(Math.max(current, step));
}

/** One level off (reversal on appeal, D16). */
export function levelAfterReversal(current: number): StrikeLevel {
  return clampLevel(current - 1);
}

export function clampLevel(value: number): StrikeLevel {
  return Math.max(0, Math.min(MAX_LEVEL, Math.trunc(value))) as StrikeLevel;
}

/** End of a suspension starting at `now`; a running longer one is kept. */
export function suspensionUntil(now: Date, days: number, current?: Date | null): Date {
  const until = new Date(now.getTime() + days * DAY_MS);
  return current && current.getTime() > until.getTime() ? current : until;
}

export interface BanCheck {
  role: "moderator" | "admin";
  template: Pick<DecisionTemplate, "p0">;
  /** Priorities of the open reports the decision closes. */
  priorities: readonly ReportPriority[];
}

/** AF §6 matrix: a moderator bans only to confirm a P0 report he handles; an admin always. */
export function canBan({ role, template, priorities }: BanCheck): boolean {
  if (role === "admin") return true;
  return template.p0 === true && priorities.includes("P0");
}

/**
 * The account sanction of a decision: a user template's own measure, a P0 template's ban (AF §7
 * step 6: confirmed P0 content means an immediate ban), else what the moderator chose.
 */
export function sanctionOf(template: Pick<DecisionTemplate, "action" | "p0" | "durationDays" | "targets">, chosen: Sanction | undefined): Sanction | null {
  if (template.action === "warn") return { action: "warn" };
  if (template.action === "ban") return { action: "ban" };
  if (template.action === "suspend_account") return { action: "suspend_account", durationDays: template.durationDays ?? 7 };
  if (template.p0) return { action: "ban" };
  if (template.action === "remove" || template.action === "restrict_visibility") return chosen ?? null;
  return null;
}
