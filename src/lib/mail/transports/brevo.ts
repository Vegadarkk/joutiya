import "server-only";
import { serverEnv } from "@/lib/env";
import type { MailTransport, RenderedMail, SendResult } from "../types";
import { isRetryableStatus, leadingInt, networkError, ProviderError, readErrorBody, SEND_TIMEOUT_MS } from "./errors";

// Brevo (phase-2/research/services.md §3), the overflow for security mails only: POST /v3/smtp/email,
// `api-key` header, `{ sender, to, subject, htmlContent, textContent }`, 201 `{ messageId }`.

export const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export interface MailAddress {
  email: string;
  name?: string;
}

/** "Name <addr>" → { name, email }; a bare address → { email }. */
export function parseAddress(value: string): MailAddress {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(value);
  if (match) {
    const name = (match[1] ?? "").trim();
    return name ? { name: name.slice(0, 70), email: match[2] ?? "" } : { email: match[2] ?? "" };
  }
  return { email: value.trim() };
}

interface BrevoRequestBody {
  sender: MailAddress;
  to: { email: string }[];
  subject: string;
  htmlContent: string;
  textContent: string;
  replyTo?: MailAddress;
  headers?: Record<string, string>;
  tags?: string[];
}

export class BrevoTransport implements MailTransport {
  readonly name = "brevo";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly userAgent = `joutiya/${serverEnv().RELEASE ?? "dev"}`,
  ) {}

  async send(mail: RenderedMail): Promise<SendResult> {
    const body: BrevoRequestBody = {
      sender: parseAddress(mail.from),
      to: [{ email: mail.to }],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
      ...(mail.replyTo ? { replyTo: parseAddress(mail.replyTo) } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
    };
    if (mail.tags) {
      const tags = Object.entries(mail.tags).map(([name, value]) => `${name}:${value}`.slice(0, 50));
      if (tags.length > 0) body.tags = tags;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(BREVO_ENDPOINT, {
        method: "POST",
        headers: { "api-key": this.apiKey, "Content-Type": "application/json", Accept: "application/json", "User-Agent": this.userAgent },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(this.name, error);
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const retryAfter = leadingInt(response.headers.get("retry-after")) ?? leadingInt(response.headers.get("x-sib-ratelimit-reset"));
      throw new ProviderError(this.name, response.status, isRetryableStatus(response.status), `brevo: HTTP ${response.status}${detail.name ? ` ${detail.name}` : ""}${detail.message ? ` (${detail.message})` : ""}`, retryAfter);
    }

    let id = "";
    try {
      const data = (await response.json()) as { messageId?: unknown; messageIds?: unknown };
      if (typeof data.messageId === "string") id = data.messageId;
      else if (Array.isArray(data.messageIds) && typeof data.messageIds[0] === "string") id = data.messageIds[0];
    } catch {
      // Accepted without a readable body.
    }
    return { provider: this.name, id };
  }
}
