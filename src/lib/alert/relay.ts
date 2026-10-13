import { createHmac } from "node:crypto";
import type { Alert, AlertChannel } from "./types";

/**
 * E-mail through the uptime Worker (workers/uptime-probe): it relays signed alerts to the
 * owner's verified address with Cloudflare's free send_email binding. Independent of Resend,
 * so quota or outage there never silences an alert.
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
    if (!response.ok) throw new Error(`alert relay: HTTP ${response.status}`);
  }
}
