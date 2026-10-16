import "server-only";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type RateLimiterAbstract } from "rate-limiter-flexible";
import { RATE_LIMITS, type RateLimitId } from "@/config/rate-limits";
import { HttpError, rateLimited, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { pepperedHash } from "@/lib/security/hash";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Limiters on valkey-ratelimit (§6). Redis down: `rejectIfRedisNotReady` and a short command
// timeout make the call fail fast, then the limiter's policy decides (open or closed). Without
// RATE_LIMIT_REDIS_URL (local dev, unit tests) an in-memory limiter applies the same table.

export type LimitOutcome =
  | { ok: true; remaining: number }
  | { ok: false; reason: "limited"; retryAfterSeconds: number }
  | { ok: false; reason: "unavailable" };

const limiters = new Map<RateLimitId, RateLimiterAbstract>();

function build(id: RateLimitId): RateLimiterAbstract {
  const definition = RATE_LIMITS[id];
  const common = {
    keyPrefix: `rl:${id}`,
    points: definition.points,
    duration: definition.duration,
    blockDuration: "blockDuration" in definition ? definition.blockDuration : 0,
  };
  if (!isValkeyConfigured("ratelimit")) return new RateLimiterMemory(common);
  return new RateLimiterRedis({
    ...common,
    storeClient: valkey("ratelimit"),
    rejectIfRedisNotReady: true,
  });
}

function limiter(id: RateLimitId): RateLimiterAbstract {
  let instance = limiters.get(id);
  if (!instance) {
    instance = build(id);
    limiters.set(id, instance);
  }
  return instance;
}

/** HMAC of the raw key under the pepper: no IP, e-mail or uid in clear in Valkey. */
export function limitKey(id: RateLimitId, raw: string): string {
  return pepperedHash(`rl:${id}`, raw).slice(0, 32);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rate limiter timeout")), ms))]);
}

/** Consumes `points` for `rawKey`. Never throws: the outcome carries the decision. */
export async function consumeLimit(id: RateLimitId, rawKey: string, points = 1): Promise<LimitOutcome> {
  try {
    const result = await withTimeout(limiter(id).consume(limitKey(id, rawKey), points), 500);
    return { ok: true, remaining: result.remainingPoints };
  } catch (error) {
    if (error instanceof RateLimiterRes) return { ok: false, reason: "limited", retryAfterSeconds: Math.ceil(error.msBeforeNext / 1000) };
    logger.warn({ limiter: id, err: (error as Error).message }, "rate limiter unavailable");
    return { ok: false, reason: "unavailable" };
  }
}

/** Points already consumed for `rawKey` in the current window (0 when none, null when unknown). */
export async function consumedPoints(id: RateLimitId, rawKey: string): Promise<number | null> {
  try {
    const result = await withTimeout(limiter(id).get(limitKey(id, rawKey)), 500);
    return result?.consumedPoints ?? 0;
  } catch {
    return null;
  }
}

/** Forgets a key (successful login clears the failure counters of that account + IP). */
export async function resetLimit(id: RateLimitId, rawKey: string): Promise<void> {
  try {
    await withTimeout(limiter(id).delete(limitKey(id, rawKey)), 500);
  } catch {
    // Best effort.
  }
}

/**
 * Throws the HTTP error matching an outcome: 429 with Retry-After when limited, 503 when the store
 * is down and the limiter's policy is "closed". An "open" limiter lets the request through.
 */
export function assertLimit(id: RateLimitId, outcome: LimitOutcome): void {
  if (outcome.ok) return;
  if (outcome.reason === "limited") throw rateLimited(outcome.retryAfterSeconds);
  if (RATE_LIMITS[id].policy === "closed") throw unavailable("rate limiter unavailable");
}

/** consumeLimit + assertLimit in one call. */
export async function enforceLimit(id: RateLimitId, rawKey: string, points = 1): Promise<void> {
  assertLimit(id, await consumeLimit(id, rawKey, points));
}

export function isRateLimitError(error: unknown): boolean {
  return error instanceof HttpError && (error.code === "rate_limited" || error.code === "unavailable");
}

/** Tests only: drop every limiter (memory state included). */
export function resetRateLimiters(): void {
  limiters.clear();
}
