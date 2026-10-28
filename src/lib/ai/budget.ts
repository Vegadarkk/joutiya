import "server-only";
import type { AiConfig } from "@/config/ai";
import { alert } from "@/lib/alert";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Claude budget switch (design D19, Z4): the agent leaves Claude for the free fallbacks when the
// `claude.budget` quota reaches its degraded level (80 % of 5 USD = 4 USD, app-side counter fed
// from each response's `usage`) or when the API answers a spend-limit error (Console cap reached).
// The spend-limit latch lives in valkey-queue until the 1st of next month 00:00 UTC, with an
// in-process copy so a Valkey outage does not resend refused calls from this worker.

export const SPEND_LIMIT_KEY = "ai:claude:spend-limit";

export type ClaudeBlock = "budget" | "spend_limit";

let localLatchUntil = 0;

/** Start of the next monthly period of `claude.budget` (UTC month): 1st of next month, 00:00 UTC. */
export function latchUntil(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Why Claude must not be called now, or null. Unknown counter or latch counts as available. */
export async function claudeBlocked(now = new Date()): Promise<ClaudeBlock | null> {
  if (localLatchUntil > now.getTime()) return "spend_limit";
  if (isValkeyConfigured("queue")) {
    try {
      if ((await valkey("queue").exists(SPEND_LIMIT_KEY)) === 1) return "spend_limit";
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "ai: spend-limit latch unreadable");
    }
  }
  return (await isDegraded("claude.budget")) ? "budget" : null;
}

/** Latches the switch until next month after a spend-limit error; alerts once per month. */
export async function latchSpendLimit(now = new Date()): Promise<void> {
  const until = latchUntil(now);
  localLatchUntil = until.getTime();
  let first = true;
  if (isValkeyConfigured("queue")) {
    try {
      first = (await valkey("queue").set(SPEND_LIMIT_KEY, now.toISOString(), "PXAT", until.getTime(), "NX")) === "OK";
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "ai: spend-limit latch not stored");
    }
  }
  if (!first) return;
  await alert({
    severity: "P1",
    title: "Claude : plafond de dépenses atteint",
    body: `L'API Claude refuse les requêtes (plafond de la Console). L'agent passe aux secours gratuits jusqu'au ${until.toISOString().slice(0, 10)}.`,
  });
}

/** Tests only. */
export function resetSpendLimitLatch(): void {
  localLatchUntil = 0;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

type Price = AiConfig["prices"][string];

/** The model's price, or the most expensive known one (never under-count an unknown model). */
export function priceOf(config: Pick<AiConfig, "prices">, model: string): Price {
  const known = config.prices[model];
  if (known) return known;
  const all = Object.values(config.prices);
  return {
    input: Math.max(0, ...all.map((price) => price.input)),
    output: Math.max(0, ...all.map((price) => price.output)),
    cacheRead: Math.max(0, ...all.map((price) => price.cacheRead)),
    cacheWrite: Math.max(0, ...all.map((price) => price.cacheWrite)),
  };
}

/** USD per million tokens x tokens = micro-USD. Cache writes are priced as 1-hour writes. */
export function costMicroUsd(price: Price, usage: ClaudeUsage): number {
  const micros =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite;
  return Math.max(0, Math.ceil(micros));
}

/** Counts a call's cost into `claude.budget`; returns the micro-USD recorded. Never throws. */
export async function recordClaudeCost(config: Pick<AiConfig, "prices">, model: string, usage: ClaudeUsage): Promise<number> {
  const micros = costMicroUsd(priceOf(config, model), usage);
  if (micros > 0) await consume("claude.budget", micros);
  return micros;
}
