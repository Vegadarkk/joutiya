import { logger } from "@/lib/logging/logger";

// Provider failures carry what the queue should do with them (deliverMail decides, the worker
// applies):
//   transient   429 (rate limit), 5xx, network: BullMQ retries with backoff (five quick attempts);
//   quota       a 429 for a spent sending quota (Resend: daily_quota_exceeded,
//               monthly_quota_exceeded), or any 429 asking to wait more than a minute. Retrying
//               in place would burn the attempts: the mail waits for the provider's reset
//               (security mails take Brevo first);
//   unavailable 401/402/403/404: revoked key, unverified domain, unpaid account or a moved
//               endpoint. Never retried on the same provider: alert, fallback or wait an hour;
//   rejected    400/422 and the rest: a retry would fail the same way. Logged and dropped.

export type ProviderErrorKind = "transient" | "quota" | "unavailable" | "rejected";

export class ProviderError extends Error {
  /** True for transient failures only: the queue's exponential backoff makes sense for them. */
  readonly retryable: boolean;

  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = kind === "transient";
  }
}

/** A 429 asking to wait longer than this is a spent quota, not a rate limit (Resend's is per second). */
export const QUOTA_RETRY_AFTER_SECONDS = 60;

/**
 * True for a 429 that refuses for a spent sending quota: the error name or message says "quota"
 * (Resend: daily_quota_exceeded, monthly_quota_exceeded), or Retry-After exceeds a minute.
 */
export function isQuotaRefusal(status: number, detail: { name?: string; message?: string }, retryAfterSeconds?: number): boolean {
  if (status !== 429) return false;
  if (/quota/i.test(detail.name ?? "") || /quota/i.test(detail.message ?? "")) return true;
  return retryAfterSeconds !== undefined && retryAfterSeconds > QUOTA_RETRY_AFTER_SECONDS;
}

/** Kind of a non-2xx answer; with the error body and Retry-After, a quota refusal is told from a rate limit. */
export function classifyStatus(status: number, detail: { name?: string; message?: string } = {}, retryAfterSeconds?: number): ProviderErrorKind {
  if (isQuotaRefusal(status, detail, retryAfterSeconds)) return "quota";
  if (status === 429 || status >= 500) return "transient";
  if (status === 401 || status === 402 || status === 403 || status === 404) return "unavailable";
  return "rejected";
}

/** Leading integer of a header value ("12", "12/100", "12 emails"), or undefined. */
export function leadingInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** Error body `{ name, message }` of a provider, read defensively (never throws, never logs secrets). */
export async function readErrorBody(response: Response): Promise<{ name?: string; message?: string }> {
  try {
    const text = (await response.text()).slice(0, 2_000);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      name: typeof parsed["name"] === "string" ? parsed["name"] : typeof parsed["code"] === "string" ? parsed["code"] : undefined,
      message: typeof parsed["message"] === "string" ? parsed["message"].slice(0, 300) : undefined,
    };
  } catch {
    return {};
  }
}

/** Anything that looks like an e-mail address, replaced before a provider message is logged. */
const ADDRESS = /[^\s<>"'`]+@[^\s<>"'`]+/g;

/**
 * Error for a non-2xx answer. The provider's own message may quote the recipient address: it is
 * scrubbed before the log line (pino redacts by key, not by value) and never enters the error,
 * which reaches Sentry on the final attempt.
 */
export function providerFailure(
  provider: string,
  status: number,
  kind: ProviderErrorKind,
  detail: { name?: string; message?: string },
  retryAfterSeconds?: number,
): ProviderError {
  logger.warn({ provider, status, kind, error: detail.name, detail: detail.message?.replace(ADDRESS, "[redacted]") }, "mail provider error");
  return new ProviderError(provider, status, kind, `${provider}: HTTP ${status}${detail.name ? ` ${detail.name}` : ""}`, retryAfterSeconds);
}

export const SEND_TIMEOUT_MS = 10_000;

/** fetch() failures (DNS, reset, timeout) are transient from the queue's point of view. */
export function networkError(provider: string, error: unknown): ProviderError {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new ProviderError(provider, undefined, "transient", `${provider}: network failure (${reason.slice(0, 200)})`);
}
