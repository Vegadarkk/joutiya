import "server-only";
import { alert } from "@/lib/alert";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { renderMail } from "./render";
import { isSuppressed } from "./suppressions";
import { BrevoTransport } from "./transports/brevo";
import { ProviderError } from "./transports/errors";
import { MemoryTransport } from "./transports/memory";
import { ResendTransport } from "./transports/resend";
import type { MailPriority, MailTransport, RenderedMail, SendResult, TemplateMail } from "./types";

// One delivery (worker job, or inline without a queue). Transport choice (§2 adapters, §9 quotas):
//   dev + DEV_MAILBOX, or no provider key      → memory mailbox
//   otherwise                                  → Resend
//   Resend quota degraded or retryable failure → Brevo, security mails only (alert once a day)
// Retryable errors are rethrown (BullMQ backoff); a rejected mail is logged and dropped.

export type DeliverOutcome = SendResult | { skipped: "suppressed" | "quota" | "rejected" };

const RESEND_QUOTAS = ["resend.daily", "resend.monthly"] as const;

let lastFallbackAlertDay: string | undefined;

/** True the first time today (SET NX in valkey-queue when configured, else in-process). */
async function firstFallbackToday(day: string): Promise<boolean> {
  if (isValkeyConfigured("queue")) {
    try {
      return (await valkey("queue").set(`mail:fallback-alert:${day}`, "1", "EX", 2 * 86_400, "NX")) === "OK";
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "fallback alert marker unavailable");
    }
  }
  if (lastFallbackAlertDay === day) return false;
  lastFallbackAlertDay = day;
  return true;
}

async function alertFallback(reason: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (!(await firstFallbackToday(day))) return;
  await alert({
    severity: "P2",
    title: "Mail: bascule sur Brevo",
    body: `Les e-mails de sécurité partent par Brevo (${reason}). Vérifier le quota Resend et la file "mail".`,
  });
}

async function resendDegraded(): Promise<boolean> {
  for (const id of RESEND_QUOTAS) if (await isDegraded(id)) return true;
  return false;
}

async function sendWith(transport: MailTransport, rendered: RenderedMail, mail: TemplateMail): Promise<SendResult> {
  const result = await transport.send(rendered, mail.idempotencyKey);
  logger.info({ template: mail.template, locale: mail.locale, provider: result.provider, id: result.id, quota: result.quota }, "mail sent");
  return result;
}

async function sendBrevo(apiKey: string, rendered: RenderedMail, mail: TemplateMail, reason: string): Promise<SendResult> {
  if (await isDegraded("brevo.daily")) {
    throw new ProviderError("brevo", undefined, true, "brevo: daily quota exhausted, security mail deferred");
  }
  const result = await sendWith(new BrevoTransport(apiKey), rendered, mail);
  await consume("brevo.daily");
  await alertFallback(reason);
  return result;
}

export async function deliverMail(mail: TemplateMail): Promise<DeliverOutcome> {
  const env = serverEnv();
  const priority: MailPriority = mail.priority ?? "transactional";
  const rendered = renderMail(mail);

  if (priority !== "security" && (await isSuppressed(mail.to))) {
    logger.info({ template: mail.template, priority }, "mail skipped: recipient suppressed");
    return { skipped: "suppressed" };
  }

  const useMemory = env.APP_ENV === "dev" && (env.DEV_MAILBOX || !env.MAIL_API_KEY);
  if (useMemory || !env.MAIL_API_KEY) {
    if (!useMemory) logger.error({ template: mail.template }, "MAIL_API_KEY is not set: mail kept in memory");
    return sendWith(new MemoryTransport(), rendered, mail);
  }

  const fallbackKey = env.MAIL_FALLBACK_API_KEY;
  const canFallback = priority === "security" && Boolean(fallbackKey);

  if (await resendDegraded()) {
    if (!canFallback) {
      logger.info({ template: mail.template, priority }, "mail skipped: Resend quota degraded");
      return { skipped: "quota" };
    }
    return sendBrevo(fallbackKey as string, rendered, mail, "quota Resend atteint");
  }

  try {
    const result = await sendWith(new ResendTransport(env.MAIL_API_KEY), rendered, mail);
    for (const id of RESEND_QUOTAS) await consume(id);
    return result;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (!error.retryable) {
      // Bad address or payload: a retry would fail the same way. Logged (no address), job completes.
      logger.error({ template: mail.template, provider: error.provider, status: error.status, err: error.message }, "mail rejected by provider");
      return { skipped: "rejected" };
    }
    if (canFallback) {
      logger.warn({ template: mail.template, status: error.status, err: error.message }, "Resend failed: falling back to Brevo");
      return sendBrevo(fallbackKey as string, rendered, mail, `Resend HTTP ${error.status ?? "réseau"}`);
    }
    throw error;
  }
}
