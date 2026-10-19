import "server-only";
import { alert } from "@/lib/alert";
import { serverEnv } from "@/lib/env";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded, isExhausted, nextReset, raiseTo } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { renderMail } from "./render";
import { isSuppressed } from "./suppressions";
import { setMailPublisher } from "./templates/layout";
import { BrevoTransport } from "./transports/brevo";
import { ProviderError } from "./transports/errors";
import { MemoryTransport } from "./transports/memory";
import { ResendTransport } from "./transports/resend";
import type { MailPriority, MailTransport, RenderedMail, SendResult, TemplateMail } from "./types";

// One delivery (worker job, or inline without a queue). Transport choice (§2 adapters, §9 quotas):
//   dev + DEV_MAILBOX, or no provider key      → memory mailbox
//   otherwise                                  → Resend
//   Resend degraded (90 %)                     → security mails keep the last 10 %; transactional
//                                                mails wait for the reset (deferred); bulk skipped
//   Resend exhausted (100 %) or unavailable    → Brevo, security mails only (alert once a day)
//   Resend refuses for its quota (429)         → Brevo for security mails, else wait for the daily
//                                                reset (its own count includes the uptime Worker)
//   Resend transient failure (429, 5xx, net)   → Brevo for security mails, else rethrown (backoff)
//   nothing left (both quotas, no key)         → MailDeferredError: the worker delays the job; a
//                                                waiting security mail raises a P1 once a day
// A rejected mail (bad address or payload) is logged and dropped.

export type DeliverOutcome = SendResult | { skipped: "suppressed" | "quota" | "rejected" };

/** The mail cannot leave now but will later: the worker delays the job to `retryAt` (no attempt burnt). */
export class MailDeferredError extends Error {
  constructor(
    readonly retryAt: Date,
    message: string,
  ) {
    super(message);
    this.name = "MailDeferredError";
  }
}

const RESEND_QUOTAS = ["resend.daily", "resend.monthly"] as const;
type ResendQuota = (typeof RESEND_QUOTAS)[number];

/** A provider refusing the key or the domain is tried again hourly, not five times in eight minutes. */
export const PROVIDER_UNAVAILABLE_RETRY_MS = 3_600_000;
/** After a quota reset, against clock skew between the VM and the provider. */
const RESET_MARGIN_MS = 60_000;

const alertedToday = new Map<string, string>();

/** True the first time today for this alert kind (SET NX in valkey-queue when configured, else in-process). */
async function firstToday(kind: string, day: string): Promise<boolean> {
  if (isValkeyConfigured("queue")) {
    try {
      return (await valkey("queue").set(`mail:alert:${kind}:${day}`, "1", "EX", 2 * 86_400, "NX")) === "OK";
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "mail alert marker unavailable");
    }
  }
  if (alertedToday.get(kind) === day) return false;
  alertedToday.set(kind, day);
  return true;
}

/** Tests: forgets the in-process daily alert markers. */
export function resetMailAlertMarkers(): void {
  alertedToday.clear();
}

async function alertFallback(reason: string): Promise<void> {
  if (!(await firstToday("fallback", new Date().toISOString().slice(0, 10)))) return;
  await alert({
    severity: "P2",
    title: "Mail: bascule sur Brevo",
    body: `Les e-mails de sécurité partent par Brevo (${reason}). Vérifier le quota Resend et la file "mail".`,
  });
}

async function alertUnavailable(error: ProviderError, canFallback: boolean): Promise<void> {
  if (!(await firstToday(`unavailable:${error.provider}`, new Date().toISOString().slice(0, 10)))) return;
  await alert({
    severity: "P1",
    title: `Mail: ${error.provider} indisponible (HTTP ${error.status ?? "?"})`,
    body:
      `${error.message}. Clé révoquée, domaine non vérifié ou compte suspendu : vérifier le tableau de bord du fournisseur. ` +
      (canFallback ? "Les e-mails de sécurité partent par Brevo ; les autres" : "Tous les e-mails") +
      " réessaient toutes les heures depuis la file \"mail\".",
  });
}

/** Security mails waiting in the queue: the owner hears it once a day, whatever the quota alerts said. */
async function alertSecurityDeferred(cause: string, retryAt: Date): Promise<void> {
  if (!(await firstToday("security-deferred", new Date().toISOString().slice(0, 10)))) return;
  await alert({
    severity: "P1",
    title: "Mail: e-mails de sécurité en attente",
    body: `${cause}, reprise à ${retryAt.toISOString()}. Les e-mails de sécurité (vérification d'adresse, mot de passe) attendent dans la file "mail".`,
  });
}

/** The Resend quotas in degraded mode (from 90 %): the resets a non-security mail waits for. */
async function degradedResendQuotas(): Promise<ResendQuota[]> {
  const degraded: ResendQuota[] = [];
  for (const id of RESEND_QUOTAS) if (await isDegraded(id)) degraded.push(id);
  return degraded;
}

/** When Resend can send again: once every exhausted counter has reset, or now. */
async function resendAvailableAt(): Promise<Date | undefined> {
  let latest: Date | undefined;
  for (const id of RESEND_QUOTAS) {
    if (!(await isExhausted(id))) continue;
    const reset = nextReset(id);
    if (!latest || reset > latest) latest = reset;
  }
  return latest;
}

/** Waits for the earliest of `candidates` plus the margin, or for `notBefore` when later (the provider's Retry-After). */
function deferral(candidates: Date[], reason: string, notBefore?: Date): MailDeferredError {
  const earliest = candidates.reduce((best, date) => (date < best ? date : best));
  const retryAt = new Date(earliest.getTime() + RESET_MARGIN_MS);
  return new MailDeferredError(notBefore && notBefore > retryAt ? notBefore : retryAt, reason);
}

async function securityDeferral(candidates: Date[], reason: string, cause: string, notBefore?: Date): Promise<MailDeferredError> {
  const error = deferral(candidates, reason, notBefore);
  await alertSecurityDeferred(cause, error.retryAt);
  return error;
}

async function sendWith(transport: MailTransport, rendered: RenderedMail, mail: TemplateMail): Promise<SendResult> {
  const result = await transport.send(rendered, mail.idempotencyKey);
  logger.info({ template: mail.template, locale: mail.locale, provider: result.provider, id: result.id, quota: result.quota }, "mail sent");
  return result;
}

async function sendBrevo(apiKey: string, rendered: RenderedMail, mail: TemplateMail, reason: string): Promise<SendResult> {
  const result = await sendWith(new BrevoTransport(apiKey), rendered, mail);
  await consume("brevo.daily");
  await alertFallback(reason);
  return result;
}

/**
 * Resend's headers count the whole account (the uptime Worker's relay mails included) and survive
 * a lost local counter: the local counters never stay below them.
 */
async function syncResendCounters(quota: SendResult["quota"]): Promise<void> {
  if (quota?.daily !== undefined) await raiseTo("resend.daily", quota.daily);
  if (quota?.monthly !== undefined) await raiseTo("resend.monthly", quota.monthly);
}

export async function deliverMail(mail: TemplateMail): Promise<DeliverOutcome> {
  const env = serverEnv();
  const priority: MailPriority = mail.priority ?? "transactional";
  const security = priority === "security";
  setMailPublisher(await getLegalConfig());
  const rendered = renderMail(mail);

  if (!security && (await isSuppressed(mail.to))) {
    logger.info({ template: mail.template, priority }, "mail skipped: recipient suppressed");
    return { skipped: "suppressed" };
  }

  const useMemory = env.APP_ENV === "dev" && (env.DEV_MAILBOX || !env.MAIL_API_KEY);
  if (useMemory || !env.MAIL_API_KEY) {
    if (!useMemory) logger.error({ template: mail.template }, "MAIL_API_KEY is not set: mail kept in memory");
    return sendWith(new MemoryTransport(), rendered, mail);
  }

  const fallbackKey = env.MAIL_FALLBACK_API_KEY;
  const canFallback = security && Boolean(fallbackKey);
  const brevoOpen = async () => canFallback && !(await isExhausted("brevo.daily"));

  // Quotas: from 90 % only security mails still use Resend (the reserved last 10 %); transactional
  // mails (statements of reasons included) wait in the queue for the reset of the degraded quota,
  // bulk mails are dropped (the digest job stops itself). At 100 % security mails move to Brevo,
  // and once nothing is left the job waits for the earliest reset.
  if (!security) {
    const degraded = await degradedResendQuotas();
    if (degraded.length > 0) {
      if (priority === "bulk") {
        logger.info({ template: mail.template, priority }, "mail skipped: Resend quota degraded");
        return { skipped: "quota" };
      }
      throw deferral(degraded.map((id) => nextReset(id)), "Resend reserved for security mails");
    }
  }
  const resendBackAt = security ? await resendAvailableAt() : undefined;
  if (resendBackAt) {
    if (await brevoOpen()) return sendBrevo(fallbackKey as string, rendered, mail, "quota Resend atteint");
    const resets = [resendBackAt, ...(fallbackKey ? [nextReset("brevo.daily")] : [])];
    throw fallbackKey
      ? await securityDeferral(resets, "Resend and Brevo quotas exhausted", "Resend et Brevo épuisés")
      : await securityDeferral(resets, "Resend quota exhausted, no fallback key", "Resend épuisé, pas de clé Brevo");
  }

  try {
    const result = await sendWith(new ResendTransport(env.MAIL_API_KEY), rendered, mail);
    for (const id of RESEND_QUOTAS) await consume(id);
    await syncResendCounters(result.quota);
    return result;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.kind === "rejected") {
      // Bad address or payload: a retry would fail the same way. Logged (no address), job completes.
      logger.error({ template: mail.template, provider: error.provider, status: error.status, err: error.message }, "mail rejected by provider");
      return { skipped: "rejected" };
    }
    if (error.kind === "unavailable") {
      // Revoked key, unverified domain: the owner must act. Security mails take Brevo, the rest wait.
      await alertUnavailable(error, canFallback);
      if (await brevoOpen()) return sendBrevo(fallbackKey as string, rendered, mail, `Resend HTTP ${error.status ?? "?"}`);
      throw new MailDeferredError(new Date(Date.now() + PROVIDER_UNAVAILABLE_RETRY_MS), `${error.message}: retry in one hour`);
    }
    if (error.kind === "quota") {
      // Resend's own count says the account is spent (the uptime Worker shares it, a local counter
      // may have been lost): Brevo now for security mails, else wait for the daily reset, or for the
      // provider's Retry-After when it is later. The quick retries would only burn the attempts.
      logger.warn({ template: mail.template, priority, err: error.message, retryAfterSeconds: error.retryAfterSeconds }, "Resend refused: quota spent");
      if (await brevoOpen()) return sendBrevo(fallbackKey as string, rendered, mail, "quota Resend refusé");
      const resets = [nextReset("resend.daily")];
      const notBefore = error.retryAfterSeconds === undefined ? undefined : new Date(Date.now() + error.retryAfterSeconds * 1000);
      if (!security) throw deferral(resets, "Resend quota refused", notBefore);
      throw fallbackKey
        ? await securityDeferral(resets, "Resend quota refused, Brevo exhausted", "Resend refuse (quota atteint) et Brevo épuisé", notBefore)
        : await securityDeferral(resets, "Resend quota refused, no fallback key", "Resend refuse (quota atteint), pas de clé Brevo", notBefore);
    }
    // Transient (429, 5xx, network): Brevo now for security mails, else the queue's backoff.
    if (await brevoOpen()) {
      logger.warn({ template: mail.template, status: error.status, err: error.message }, "Resend failed: falling back to Brevo");
      return sendBrevo(fallbackKey as string, rendered, mail, `Resend HTTP ${error.status ?? "réseau"}`);
    }
    throw error;
  }
}
