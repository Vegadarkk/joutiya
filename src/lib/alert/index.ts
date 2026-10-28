import "server-only";
import { createHash } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { RelayEmailChannel } from "./relay";
import { TelegramChannel } from "./telegram";
import type { Alert, AlertChannel, ChannelOutcome } from "./types";

export type { Alert, ChannelOutcome, Severity } from "./types";

let channels: AlertChannel[] | undefined;

function configuredChannels(): AlertChannel[] {
  if (channels) return channels;
  const env = serverEnv();
  channels = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push(new TelegramChannel(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID));
  if (env.ALERT_RELAY_URL && env.ALERT_RELAY_SECRET) channels.push(new RelayEmailChannel(env.ALERT_RELAY_URL, env.ALERT_RELAY_SECRET));
  return channels;
}

/** Names of the configured channels (the drill's dry run). */
export function alertChannelNames(): string[] {
  return configuredChannels().map((channel) => channel.name);
}

/** Tests: replaces the configured channels (undefined reads the environment again). */
export function setAlertChannels(next: AlertChannel[] | undefined): void {
  channels = next;
}

/** Same title again within the hour: one notification is enough (the relay's daily cap is advisory). */
export const ALERT_DEDUPE_SECONDS = 3_600;

const memoryMarkers = new Map<string, number>();

/** True when the same title went out within the hour. SET NX in valkey-queue; in-process without it; fails open. */
async function isRepeat(title: string, now = Date.now()): Promise<boolean> {
  const key = `alert:sent:${createHash("sha256").update(title).digest("hex").slice(0, 32)}`;
  if (isValkeyConfigured("queue")) {
    try {
      return (await valkey("queue").set(key, "1", "EX", ALERT_DEDUPE_SECONDS, "NX")) !== "OK";
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "alert dedupe marker unavailable");
      return false;
    }
  }
  for (const [marker, expires] of memoryMarkers) if (expires <= now) memoryMarkers.delete(marker);
  if (memoryMarkers.has(key)) return true;
  memoryMarkers.set(key, now + ALERT_DEDUPE_SECONDS * 1_000);
  return false;
}

/**
 * Sends an alert on every channel (Telegram and e-mail, Z5). Never throws: a failing channel is
 * logged, the others still deliver. Without any channel (local dev), the alert is only logged.
 * Returns false when the same title already went out within the hour (nothing sent).
 */
export async function alert(event: Alert): Promise<boolean> {
  if (await isRepeat(event.title)) {
    logger.info({ alert: { severity: event.severity, title: event.title } }, "alert repeated within the hour: not sent again");
    return false;
  }
  logger.warn({ alert: { severity: event.severity, title: event.title } }, "alert");
  await deliver(event);
  return true;
}

/**
 * Sends on every configured channel, without the hourly dedupe, and logs each outcome. Never
 * throws. alert() and the P0 drill (scripts/alert-drill.ts) both go through it.
 */
export async function deliver(event: Alert): Promise<ChannelOutcome[]> {
  const env = serverEnv().APP_ENV;
  const channels = configuredChannels();
  const results = await Promise.allSettled(channels.map((channel) => channel.send(event, env)));
  return results.map((result, index): ChannelOutcome => {
    const channel = channels[index]!.name;
    if (result.status === "rejected") {
      logger.error({ channel, err: String(result.reason) }, "alert channel failed");
      return { channel, status: "failed", error: String(result.reason) };
    }
    const status = result.value === "off" ? "off" : "sent";
    logger.info({ channel, alert: { severity: event.severity } }, status === "off" ? "alert channel off" : "alert channel sent");
    return { channel, status };
  });
}
