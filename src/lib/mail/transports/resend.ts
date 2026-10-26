import "server-only";
import { serverEnv } from "@/lib/env";
import type { MailTransport, RenderedMail, SendResult } from "../types";
import { classifyStatus, leadingInt, networkError, providerFailure, readErrorBody, SEND_TIMEOUT_MS } from "./errors";

// Resend (phase-2/research/services.md §2): POST /emails, Bearer key, mandatory User-Agent,
// optional Idempotency-Key (24 h), `{ id }` on success, quota headers = used counts (free plan).

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendRequestBody {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

/** Resend accepts ASCII letters, digits, "_" and "-" in tag names and values. */
export function resendTags(tags: Record<string, string> | undefined): { name: string; value: string }[] | undefined {
  if (!tags) return undefined;
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
  const list = Object.entries(tags)
    .filter(([name, value]) => name && value)
    .map(([name, value]) => ({ name: clean(name), value: clean(value) }));
  return list.length > 0 ? list : undefined;
}

export class ResendTransport implements MailTransport {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly userAgent = `joutiya/${serverEnv().RELEASE ?? "dev"}`,
  ) {}

  async send(mail: RenderedMail, idempotencyKey?: string): Promise<SendResult> {
    const body: ResendRequestBody = {
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
    };
    const tags = resendTags(mail.tags);
    if (tags) body.tags = tags;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey.slice(0, 256);

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    } catch (error) {
      throw networkError(this.name, error);
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const retryAfter = leadingInt(response.headers.get("retry-after")) ?? leadingInt(response.headers.get("ratelimit-reset"));
      // 409 concurrent_idempotent_requests: the same key is in flight, a later retry resolves it.
      // 429 daily_quota_exceeded / monthly_quota_exceeded: "quota", the mail waits for the reset.
      const kind = response.status === 409 && detail.name === "concurrent_idempotent_requests" ? "transient" : classifyStatus(response.status, detail, retryAfter);
      throw providerFailure(this.name, response.status, kind, detail, retryAfter);
    }

    let id = "";
    try {
      const data = (await response.json()) as { id?: unknown };
      if (typeof data.id === "string") id = data.id;
    } catch {
      // A 2xx without a readable body still means the mail was accepted.
    }
    const result: SendResult = { provider: this.name, id };
    // Best effort: the headers report USED counts with an undocumented format (own counters stay authoritative).
    const daily = leadingInt(response.headers.get("x-resend-daily-quota"));
    const monthly = leadingInt(response.headers.get("x-resend-monthly-quota"));
    if (daily !== undefined || monthly !== undefined) {
      result.quota = { ...(daily !== undefined ? { daily } : {}), ...(monthly !== undefined ? { monthly } : {}) };
    }
    return result;
  }
}
