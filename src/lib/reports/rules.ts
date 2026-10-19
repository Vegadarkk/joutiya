import { REPORT_PRIORITIES, SLA_MS, type ReportPriority, type ReportTargetType } from "@/config/report-reasons";
import type { STRONG_SIGNALS, UserPrivateDoc, UserDoc } from "@/lib/db/schemas";

// Pure rules of the reports (design D10, D11, D12, D15): duplicates, strong signals, the trusted
// reporter, the reporter accuracy and the art. 23 measures, the P0 alert text. No I/O here: the
// service feeds them what it read, the unit tests feed them fixtures.

export type StrongSignal = (typeof STRONG_SIGNALS)[number];
export type ReporterStats = UserPrivateDoc["reporter"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** D11 "trusted": account age, decided reports among the last 10, founded share. */
export const TRUSTED_MIN_ACCOUNT_DAYS = 30;
export const TRUSTED_MIN_DECIDED = 5;
export const TRUSTED_MIN_FOUNDED_SHARE = 0.8;
/** D11 "multi": distinct reporters of open P0 reports on one target within this window. */
export const MULTI_WINDOW_MS = 7 * DAY_MS;
/** D15: outcomes kept, manifestly unfounded dates kept, the 30-day windows, the suspension length. */
export const REPORTER_RECENT_MAX = 10;
export const MANIFEST_MAX = 10;
export const MANIFEST_WINDOW_MS = 30 * DAY_MS;
export const MANIFEST_WARN_AT = 3;
export const ABUSIVE_SUSPENSION_MS = 30 * DAY_MS;

/** 0 = most urgent. */
export function priorityRank(priority: ReportPriority): number {
  return REPORT_PRIORITIES.indexOf(priority);
}

/** Target delay in whole hours (CreateReportResponse.slaHours). */
export function slaHours(priority: ReportPriority): number {
  return Math.round(SLA_MS[priority] / 3_600_000);
}

// ---- Duplicates (D10) -------------------------------------------------------------------------

export interface ReporterIdentity {
  /** Signed-in reporter. */
  uid?: string;
  /** Peppered device key hash: identifies a visitor. */
  deviceHash: string;
}

export interface OpenReportLike {
  priority: ReportPriority;
  source: "user" | "system" | "authority";
  reporter: { uid?: string; deviceHash: string };
}

/** Same reporter: the account when signed in, else the device (a visitor's earlier anonymous report). */
export function sameReporter(report: OpenReportLike, who: ReporterIdentity): boolean {
  if (report.source !== "user") return false;
  if (who.uid) return report.reporter.uid === who.uid;
  return report.reporter.uid === undefined && report.reporter.deviceHash === who.deviceHash;
}

/**
 * The open report a new notice duplicates: same reporter, same target, and a priority at least as
 * urgent as the new reason's. A more urgent reason (P3 "spam" first, then P0 "minors") is a new
 * report: deduplicating it would hide a P0 from the alerts and the strong-signal check.
 */
export function findDuplicate<T extends OpenReportLike>(open: readonly T[], who: ReporterIdentity, priority: ReportPriority): T | undefined {
  return open.find((report) => sameReporter(report, who) && priorityRank(report.priority) <= priorityRank(priority));
}

// ---- Strong signals (D11) ---------------------------------------------------------------------

export interface SignalReport {
  uid?: string;
  deviceHash: string;
  ipPrefixHash: string;
  createdAt: Date;
}

/** Distinct devices and IP prefixes, and distinct accounts when both are signed in. */
function distinctOrigins(a: SignalReport, b: SignalReport): boolean {
  if (a.uid !== undefined && a.uid === b.uid) return false;
  return a.deviceHash !== b.deviceHash && a.ipPrefixHash !== b.ipPrefixHash;
}

const inWindow = (other: SignalReport, now: Date): boolean => now.getTime() - other.createdAt.getTime() <= MULTI_WINDOW_MS;

/**
 * "multi" (strong signal): the new P0 report and at least one other open P0 user report on the same
 * target, created within 7 days, come from two distinct ACCOUNTS (both signed in) on distinct
 * devices AND IP prefixes (AF §7). A visitor has no account to answer for a false notice (art. 23),
 * so two visitors never hide anything (audit D1a-03): they only corroborate each other. `others` are
 * the open P0 reports of the target with `source: "user"` (the caller filters).
 */
export function hasMultiSignal(candidate: SignalReport, others: readonly SignalReport[], now: Date): boolean {
  if (candidate.uid === undefined) return false;
  return others.some((other) => other.uid !== undefined && inWindow(other, now) && distinctOrigins(candidate, other));
}

/**
 * Corroborated: another open user report on the same target within 7 days from a distinct device
 * and IP prefix, visitors included. Not a strong signal: it raises the priority one rank
 * (raisePriority), never hides.
 */
export function isCorroborated(candidate: SignalReport, others: readonly SignalReport[], now: Date): boolean {
  return others.some((other) => inWindow(other, now) && distinctOrigins(candidate, other));
}

/** One rank more urgent: P3 -> P2, P2 -> P1; P1 and P0 stay (a corroboration never makes a P0). */
export function raisePriority(priority: ReportPriority): ReportPriority {
  const rank = priorityRank(priority);
  return rank >= 2 ? (REPORT_PRIORITIES[rank - 1] ?? priority) : priority;
}

export interface TrustedFacts {
  user: Pick<UserDoc, "createdAt" | "status" | "badges"> | null;
  reporter: ReporterStats | null;
  now: Date;
}

/** Share of founded outcomes among the decided ones kept (null before the first decision). */
export function foundedShare(reporter: Pick<ReporterStats, "recent"> | null | undefined): number | null {
  const recent = reporter?.recent ?? [];
  if (recent.length === 0) return null;
  return recent.filter(Boolean).length / recent.length;
}

export function isAbusive(reporter: Pick<ReporterStats, "abusiveUntil"> | null | undefined, now: Date): boolean {
  return Boolean(reporter?.abusiveUntil && reporter.abusiveUntil.getTime() > now.getTime());
}

/**
 * D11 "trusted" reporter: account of at least 30 days, active, verified phone, at least 5 decided
 * reports among the last 10 with at least 80 % founded, and no art. 23 suspension running.
 */
export function trustedFromFacts({ user, reporter, now }: TrustedFacts): boolean {
  if (!user || !reporter) return false;
  if (user.status !== "active" || !user.badges.phoneVerified) return false;
  if (now.getTime() - user.createdAt.getTime() < TRUSTED_MIN_ACCOUNT_DAYS * DAY_MS) return false;
  if (isAbusive(reporter, now)) return false;
  const share = foundedShare(reporter);
  return reporter.recent.length >= TRUSTED_MIN_DECIDED && share !== null && share >= TRUSTED_MIN_FOUNDED_SHARE;
}

export interface SignalFacts {
  trusted: boolean;
  auto: boolean;
  multi: boolean;
}

/** The strong signal of a P0 user report, strongest first; undefined: nothing is hidden. */
export function strongSignalOf(priority: ReportPriority, facts: SignalFacts): StrongSignal | undefined {
  if (priority !== "P0") return undefined;
  if (facts.trusted) return "trusted";
  if (facts.auto) return "auto";
  if (facts.multi) return "multi";
  return undefined;
}

/** "auto": a stored photo of the listing with a nudity score at or above the threshold. */
export function hasAutoSignal(nsfwScores: readonly (number | undefined)[], threshold: number): boolean {
  return nsfwScores.some((score) => score !== undefined && score >= threshold);
}

// ---- Reporter accuracy and art. 23 (D15) ------------------------------------------------------

export interface ReporterOutcome {
  /** The reporter's account (anonymous reports carry no accuracy). */
  uid: string;
  founded: boolean;
  /** Dismissed and flagged "manifestly unfounded" by the moderator. */
  manifestlyUnfounded?: boolean;
}

export interface ReporterUpdate {
  reporter: ReporterStats;
  /** Third manifestly unfounded report within 30 days: the prior warning is due (mail reporterWarning). */
  warn: boolean;
  /** A new one within 30 days of the warning: reports refused until `reporter.abusiveUntil`. */
  abusive: boolean;
}

export function emptyReporter(): ReporterStats {
  return { recent: [], total: 0 };
}

/**
 * One decided report of this reporter: the last 10 outcomes, the total, and art. 23 (manifestly
 * unfounded: 3 within 30 days -> prior warning; one more within 30 days of the warning -> 30 days
 * during which the reports are refused).
 */
export function applyReporterOutcome(current: ReporterStats | null | undefined, outcome: Omit<ReporterOutcome, "uid">, now: Date): ReporterUpdate {
  const base = current ?? emptyReporter();
  const reporter: ReporterStats = {
    ...base,
    recent: [...base.recent, outcome.founded].slice(-REPORTER_RECENT_MAX),
    total: base.total + 1,
  };
  if (outcome.founded || !outcome.manifestlyUnfounded) return { reporter, warn: false, abusive: false };

  const manifest = [...(base.manifest ?? []), now].slice(-MANIFEST_MAX);
  reporter.manifest = manifest;
  const warnedRecently = base.warnedAt !== undefined && now.getTime() - base.warnedAt.getTime() <= MANIFEST_WINDOW_MS;
  if (warnedRecently) {
    reporter.abusiveUntil = new Date(now.getTime() + ABUSIVE_SUSPENSION_MS);
    return { reporter, warn: false, abusive: true };
  }
  const inWindow = manifest.filter((at) => now.getTime() - at.getTime() <= MANIFEST_WINDOW_MS).length;
  if (inWindow >= MANIFEST_WARN_AT) {
    reporter.warnedAt = now;
    return { reporter, warn: true, abusive: false };
  }
  return { reporter, warn: false, abusive: false };
}

// ---- P0 alert (D12) ---------------------------------------------------------------------------

const TARGET_LABEL: Record<ReportTargetType, string> = { listing: "annonce", user: "profil", message: "message", pro: "boutique" };

/** "16/10/2026 18:30" in Paris time (the alert's reader is the publisher's team). */
export function parisTime(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(date);
}

export interface P0AlertInput {
  reportId: string;
  targetType: ReportTargetType;
  reasonId: string;
  signal?: StrongSignal;
  hidden: boolean;
  slaDueAt: Date;
  source: "user" | "system" | "authority";
}

/** Title unique per report (beats the 1-hour alert dedupe); body without personal data. */
export function p0Alert(input: P0AlertInput): { severity: "P0"; title: string; body: string } {
  const lines = [
    `Cible : ${TARGET_LABEL[input.targetType]}`,
    `Motif : ${input.reasonId}`,
    `Origine : ${input.source}`,
    `Signal fort : ${input.signal ? `oui (${input.signal})` : "non"}`,
    `Contenu masqué : ${input.hidden ? "oui" : "non"}`,
    `Échéance : ${parisTime(input.slaDueAt)} (Paris)`,
  ];
  return { severity: "P0", title: `Signalement P0 ${input.reportId}`, body: lines.join("\n") };
}
