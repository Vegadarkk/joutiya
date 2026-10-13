// Alerter (§2 adapters, Z5): Telegram and e-mail. Swapped by configuration, never by rewrite.

export type Severity = "P0" | "P1" | "P2" | "info";

export interface Alert {
  severity: Severity;
  title: string;
  body: string;
}

export interface AlertChannel {
  readonly name: string;
  send(alert: Alert, env: string): Promise<void>;
}

const ICON: Record<Severity, string> = { P0: "🚨", P1: "🔴", P2: "🟠", info: "ℹ️" };

/** Plain text (no markup parsing on the receiving side, so no injection through alert content). */
export function formatAlert(alert: Alert, env: string): string {
  const prefix = env === "prod" ? "" : `[${env}] `;
  const text = `${ICON[alert.severity]} ${prefix}${alert.severity} · ${alert.title}\n\n${alert.body}`;
  // Telegram caps messages at 4096 characters.
  return text.length > 4000 ? `${text.slice(0, 3990)}\n[…]` : text;
}
