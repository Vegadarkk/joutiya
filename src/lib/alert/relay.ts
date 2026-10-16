import { createHmac } from "node:crypto";
import { logger } from "@/lib/logging/logger";
import type { Alert, AlertChannel } from "./types";

/**
 * E-mail through the uptime Worker (workers/uptime-probe): it relays signed alerts to the
 * owner's address through the Resend API, with a Resend key of its own that never sits on the
 * VM. The Worker answers within 6 s, inside the 8 s timeout below, and caps relayed e-mails per
 * day (429) so a flood cannot spend the site's shared Resend quota. Telegram, called directly by
 * alert(), stays the guaranteed channel: a relay failure is logged and never blocks it.
 */
export class RelayEmailChannel implements AlertChannel {
  readonly name = "email";

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(alert: Alert, env: string): Promise<void> {
    const body = JSON.stringify({ ...alert, env });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", this.secret).update(`${timestamp}.${body}`).digest("hex");
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Joutiya-Timestamp": timestamp, "X-Joutiya-Signature": signature },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    // 503: the Worker has no e-mail configured (ALERT_EMAIL_TO / RESEND_API_KEY unset). Telegram
    // already carried the alert, so this is a warning, not a channel failure to retry.
    if (response.status === 503) {
      logger.warn("alert relay: e-mail channel off on the Worker");
      return;
    }
    // 204 covers both a sent mail and a repeat of the same title within the hour (Resend idempotency).
    if (!response.ok) throw new Error(`alert relay: HTTP ${response.status}`);
  }
}
