import "server-only";
import type { DecisionAction, DecisionTargetType } from "@/config/decision-templates";
import type { Locale } from "@/config/site";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { DecisionAutomation, DecisionSource, TemplateData } from "@/lib/mail/types";
import type { ReporterOutcomesResult } from "@/lib/reports";
import { appealToken } from "./appeal-token";
import { accountRecipient, type OpenReport } from "./repository";

// Mails of the decisions (design D13-D16), sent after the commit; a failure is logged, never
// thrown (the decision stands). Statement of reasons to the affected user with the signed appeal
// link, outcome to every reporter with a known address (one mail per address), restoration notice,
// art. 23 reporter warnings. Idempotency keys make a retried call send nothing twice.

const RESTRICTIVE: readonly DecisionAction[] = ["remove", "restrict_visibility", "warn", "suspend_account", "ban"];
const MANIFEST_WINDOW_DAYS = 30;
const MANIFEST_WARN_AT = 3;

export interface NoticeInput {
  decisionId: string;
  templateId: string;
  action: DecisionAction;
  targetType: DecisionTargetType;
  affectedUid: string;
  title: string | null;
  details: string | null;
  durationDays: number | null;
  until: Date | null;
  source: DecisionSource;
  automation: DecisionAutomation;
  appealDeadline: Date;
}

async function quietly(label: string, context: Record<string, unknown>, send: () => Promise<void>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (error) {
    logger.error({ ...context, err: (error as Error).message }, `decisions: ${label} mail failed`);
    return false;
  }
}

/** Statement of reasons (art. 17) to the affected account; nothing for restore and no_action. */
export async function sendDecisionNotice(input: NoticeInput): Promise<boolean> {
  if (!RESTRICTIVE.includes(input.action)) return false;
  const to = await accountRecipient(input.affectedUid);
  if (!to) return false;
  const token = input.source === "authority_order" ? null : appealToken({ decisionId: input.decisionId, by: "affected", expiresAt: input.appealDeadline });
  const data: TemplateData["decisionNotice"] = {
    displayName: to.displayName,
    decisionId: input.decisionId,
    templateId: input.templateId,
    action: input.action as TemplateData["decisionNotice"]["action"],
    targetType: input.targetType,
    title: input.title,
    details: input.details,
    durationDays: input.durationDays,
    until: input.until?.toISOString() ?? null,
    source: input.source,
    automated: input.automation,
    appealToken: token,
    appealDeadline: input.appealDeadline.toISOString(),
  };
  return quietly("decisionNotice", { decisionId: input.decisionId }, () =>
    sendMail({ template: "decisionNotice", locale: to.locale, to: to.email, priority: "transactional", idempotencyKey: `decisionNotice-${input.decisionId}`, data }),
  );
}

interface ReporterAddress {
  email: string;
  locale: Locale;
  displayName: string | null;
}

async function reporterAddress(report: OpenReport): Promise<ReporterAddress | null> {
  if (report.source !== "user") return null;
  if (report.reporter.uid) {
    const account = await accountRecipient(report.reporter.uid);
    return account ? { email: account.email, locale: account.locale, displayName: account.displayName } : null;
  }
  return report.reporter.email ? { email: report.reporter.email, locale: report.reporter.locale, displayName: report.reporter.name ?? null } : null;
}

export interface OutcomeInput {
  decisionId: string;
  action: DecisionAction;
  outcome: "actioned" | "dismissed";
  automation: DecisionAutomation;
  appealDeadline: Date;
  /** Authority orders: no appeal through Joutiya. */
  appealable: boolean;
}

/** Outcome of the notice (art. 16(5)) to each reporter with an address, once per address. */
export async function sendReportOutcomes(reports: readonly OpenReport[], input: OutcomeInput): Promise<number> {
  const seen = new Set<string>();
  let sent = 0;
  for (const report of reports) {
    const address = await reporterAddress(report).catch(() => null);
    if (!address || seen.has(address.email.toLowerCase())) continue;
    seen.add(address.email.toLowerCase());
    const token = input.appealable ? appealToken({ decisionId: input.decisionId, by: "reporter", reportId: report.id, expiresAt: input.appealDeadline }) : null;
    const ok = await quietly("reportOutcome", { decisionId: input.decisionId, reportId: report.id }, () =>
      sendMail({
        template: "reportOutcome",
        locale: address.locale,
        to: address.email,
        priority: "transactional",
        idempotencyKey: `reportOutcome-${report.id}`,
        data: {
          displayName: address.displayName,
          reportId: report.id,
          reportedAt: report.createdAt.toISOString(),
          targetType: report.target.type,
          outcome: input.outcome,
          action: input.action,
          automated: input.automation,
          decisionId: input.decisionId,
          appealToken: token,
          appealDeadline: input.appealDeadline.toISOString(),
        },
      }),
    );
    if (ok) sent += 1;
  }
  return sent;
}

/** Hidden content shown again or an account restriction lifted (report dismissed). */
export async function sendContentRestored(uid: string, input: { targetType: DecisionTargetType; title: string | null; via: "report" | "appeal"; decisionId: string }): Promise<boolean> {
  const to = await accountRecipient(uid);
  if (!to || to.status === "banned") return false;
  return quietly("contentRestored", { decisionId: input.decisionId }, () =>
    sendMail({
      template: "contentRestored",
      locale: to.locale,
      to: to.email,
      priority: "transactional",
      idempotencyKey: `contentRestored-${input.decisionId}`,
      data: { displayName: to.displayName, targetType: input.targetType, title: input.title, via: input.via, decisionId: input.decisionId },
    }),
  );
}

/** Art. 23(2): the prior warning, then the suspension of the notices (recordReporterOutcomes' result). */
export async function sendReporterWarnings(result: ReporterOutcomesResult, until: Date): Promise<void> {
  const mails = [...result.warned.map((uid) => ({ uid, kind: "warning" as const })), ...result.suspended.map((uid) => ({ uid, kind: "suspended" as const }))];
  for (const { uid, kind } of mails) {
    const to = await accountRecipient(uid).catch(() => null);
    if (!to) continue;
    await quietly("reporterWarning", { kind }, () =>
      sendMail({
        template: "reporterWarning",
        locale: to.locale,
        to: to.email,
        priority: "transactional",
        idempotencyKey: `reporterWarning-${kind}-${uid}-${until.toISOString().slice(0, 10)}`,
        data: { displayName: to.displayName, kind, count: MANIFEST_WARN_AT, windowDays: MANIFEST_WINDOW_DAYS, until: kind === "suspended" ? until.toISOString() : null },
      }),
    );
  }
}

export interface AppellantAddress {
  email: string;
  locale: Locale;
  displayName: string | null;
}

export async function sendAppealReceived(to: AppellantAddress, input: { decisionId: string; receivedAt: Date; slaDays: number }): Promise<boolean> {
  return quietly("appealReceived", { decisionId: input.decisionId }, () =>
    sendMail({
      template: "appealReceived",
      locale: to.locale,
      to: to.email,
      priority: "transactional",
      idempotencyKey: `appealReceived-${input.decisionId}`,
      data: { displayName: to.displayName, decisionId: input.decisionId, receivedAt: input.receivedAt.toISOString(), slaDays: input.slaDays },
    }),
  );
}

export async function sendAppealOutcome(to: AppellantAddress, input: { decisionId: string; outcome: "upheld" | "reversed"; by: "affected" | "reporter"; note: string; reviewedAt: Date }): Promise<boolean> {
  return quietly("appealOutcome", { decisionId: input.decisionId }, () =>
    sendMail({
      template: "appealOutcome",
      locale: to.locale,
      to: to.email,
      priority: "transactional",
      idempotencyKey: `appealOutcome-${input.decisionId}`,
      data: { displayName: to.displayName, decisionId: input.decisionId, outcome: input.outcome, by: input.by, note: input.note, reviewedAt: input.reviewedAt.toISOString() },
    }),
  );
}

/** Address of an appellant: the affected account, or the reporter of `reportId` (account or visitor). */
export async function appellantAddress(input: { by: "affected" | "reporter"; affectedUid: string; report?: OpenReport | null }): Promise<AppellantAddress | null> {
  if (input.by === "affected") {
    const account = await accountRecipient(input.affectedUid);
    return account ? { email: account.email, locale: account.locale, displayName: account.displayName } : null;
  }
  return input.report ? reporterAddress(input.report) : null;
}
