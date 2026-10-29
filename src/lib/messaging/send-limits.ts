import "server-only";
import type { RateLimitId } from "@/config/rate-limits";
import { assertLimit, consumeLimit } from "@/lib/rate-limit/limiter";

/**
 * The send limiters (D4, audit D1a-01): a burst per minute, an hour and a day per account, and an
 * hour per account and thread. Every write to a thread counts: messages, and the offer,
 * appointment and rental-request steps. Consumed in that order and stopped at the first refusal, so a
 * refused send (a client retrying on 429) never uses up the hour and day budgets; every one is
 * open (a Valkey outage never blocks a reply).
 */
export async function enforceSendLimits(uid: string, cid: string): Promise<void> {
  const checks: readonly (readonly [RateLimitId, string])[] = [
    ["message.send.uid", uid],
    ["message.send.hour.uid", uid],
    ["message.send.day.uid", uid],
    ["message.send.thread", `${uid}:${cid}`],
  ];
  for (const [id, key] of checks) assertLimit(id, await consumeLimit(id, key));
}
