import "server-only";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { RelayEmailChannel } from "./relay";
import { TelegramChannel } from "./telegram";
import type { Alert, AlertChannel } from "./types";

export type { Alert, Severity } from "./types";

let channels: AlertChannel[] | undefined;

function configuredChannels(): AlertChannel[] {
  if (channels) return channels;
  const env = serverEnv();
  channels = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push(new TelegramChannel(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID));
  if (env.ALERT_RELAY_URL && env.ALERT_RELAY_SECRET) channels.push(new RelayEmailChannel(env.ALERT_RELAY_URL, env.ALERT_RELAY_SECRET));
  return channels;
}

/**
 * Sends an alert on every channel (Telegram and e-mail, Z5). Never throws: a failing channel is
 * logged, the others still deliver. Without any channel (local dev), the alert is only logged.
 */
export async function alert(event: Alert): Promise<void> {
  const env = serverEnv().APP_ENV;
  logger.warn({ alert: { severity: event.severity, title: event.title } }, "alert");
  const results = await Promise.allSettled(configuredChannels().map((channel) => channel.send(event, env)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error({ channel: configuredChannels()[index]?.name, err: String(result.reason) }, "alert channel failed");
    }
  });
}
