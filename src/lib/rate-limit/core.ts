import "server-only";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type RateLimiterAbstract } from "rate-limiter-flexible";
import { RATE_LIMITS, type RateLimitDefinition, type RateLimitId } from "@/config/rate-limits";
import { logger } from "@/lib/logging/logger";
import { pepperedHash } from "@/lib/security/hash";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Limiters on valkey-ratelimit (§6). Redis down: `rejectIfRedisNotReady` and a short command
// timeout make the call fail fast, then the limiter's policy decides (open or closed). Without
// RATE_LIMIT_REDIS_URL (local dev, unit tests) an in-memory limiter applies the same table.
// The client is lazy (valkey/clients.ts): it stays "wait" until something connects it, and
// rate-limiter-flexible refuses every call until it is "ready", so each call connects it first.
// The proxy bundle has its own instance of this module, hence its own client (design D14).
// No Firestore here: each call takes the definition to apply, the committed one by default (the
// proxy's page limits); limiter.ts passes the definition under the `config/abuse` overrides.

export type LimitOutcome =
  | { ok: true; remaining: number }
  | { ok: false; reason: "limited"; retryAfterSeconds: number }
  | { ok: false; reason: "unavailable" };

/** Counters live in the store under `rl:{id}`: a rebuilt Redis limiter keeps them (a memory one starts over). */
const limiters = new Map<RateLimitId, { signature: string; instance: RateLimiterAbstract }>();

function build(id: RateLimitId, definition: RateLimitDefinition): RateLimiterAbstract {
  const common = {
    keyPrefix: `rl:${id}`,
    points: definition.points,
    duration: definition.duration,
    blockDuration: definition.blockDuration ?? 0,
  };
  if (!isValkeyConfigured("ratelimit")) return new RateLimiterMemory(common);
  return new RateLimiterRedis({
    ...common,
    storeClient: valkey("ratelimit"),
    rejectIfRedisNotReady: true,
  });
}

/** The cached limiter of `id`, rebuilt when the definition it applies changed. */
function limiter(id: RateLimitId, definition: RateLimitDefinition): RateLimiterAbstract {
  const signature = `${definition.points}/${definition.duration}/${definition.blockDuration ?? 0}`;
  const cached = limiters.get(id);
  if (cached && cached.signature === signature) return cached.instance;
  const instance = build(id, definition);
  limiters.set(id, { signature, instance });
  return instance;
}

/** HMAC of the raw key under the pepper: no IP, e-mail or uid in clear in Valkey. */
export function limitKey(id: RateLimitId, raw: string): string {
  return pepperedHash(`rl:${id}`, raw).slice(0, 32);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rate limiter timeout")), ms))]);
}

let connecting: Promise<void> | undefined;

/**
 * Connects the lazy store client on first use; concurrent callers share the attempt. A failed
 * attempt resolves too: ioredis keeps reconnecting in the background and, meanwhile, the limiter
 * rejects at once ("not ready"), which the policy turns into open or closed.
 */
async function storeReady(): Promise<void> {
  if (!isValkeyConfigured("ratelimit")) return;
  const client = valkey("ratelimit");
  if (client.status === "wait") connecting = client.connect().catch(() => undefined);
  if (connecting && client.status !== "ready") await connecting;
}

/** One store call: connect first, all of it under the 500 ms budget. */
function run<T>(call: () => Promise<T>): Promise<T> {
  return withTimeout(storeReady().then(call), 500);
}

/** A store outage logs once a minute per limiter: the proxy meters every page view. */
const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;
const unavailableLoggedAt = new Map<RateLimitId, number>();

function logUnavailable(id: RateLimitId, error: unknown): void {
  const now = Date.now();
  if (now - (unavailableLoggedAt.get(id) ?? -Infinity) < UNAVAILABLE_LOG_INTERVAL_MS) return;
  unavailableLoggedAt.set(id, now);
  logger.warn({ limiter: id, err: (error as Error).message }, "rate limiter unavailable");
}

/** Consumes `points` for `rawKey` under `definition`. Never throws: the outcome carries the decision. */
export async function consumeLimit(id: RateLimitId, rawKey: string, points = 1, definition: RateLimitDefinition = RATE_LIMITS[id]): Promise<LimitOutcome> {
  try {
    const result = await run(() => limiter(id, definition).consume(limitKey(id, rawKey), points));
    return { ok: true, remaining: result.remainingPoints };
  } catch (error) {
    if (error instanceof RateLimiterRes) return { ok: false, reason: "limited", retryAfterSeconds: Math.ceil(error.msBeforeNext / 1000) };
    logUnavailable(id, error);
    return { ok: false, reason: "unavailable" };
  }
}

export interface LimitState {
  /** Points consumed in the current window (0 when the key is unknown). */
  consumedPoints: number;
  /** Milliseconds before the key frees itself (window end or block end; 0 when unknown). */
  msBeforeNext: number;
}

/** Consumed points and the time left on `rawKey`, or null when the store cannot answer. */
export async function limitState(id: RateLimitId, rawKey: string, definition: RateLimitDefinition = RATE_LIMITS[id]): Promise<LimitState | null> {
  try {
    const result = await run(() => limiter(id, definition).get(limitKey(id, rawKey)));
    return { consumedPoints: result?.consumedPoints ?? 0, msBeforeNext: Math.max(0, result?.msBeforeNext ?? 0) };
  } catch {
    return null;
  }
}

/**
 * Blocks `rawKey` for `seconds` (the definition's blockDuration, else its window) from now: the
 * store marks the key as exhausted whatever its count. Best effort, like resetLimit.
 */
export async function blockLimit(id: RateLimitId, rawKey: string, seconds?: number, definition: RateLimitDefinition = RATE_LIMITS[id]): Promise<void> {
  const duration = seconds ?? (definition.blockDuration !== undefined && definition.blockDuration > 0 ? definition.blockDuration : definition.duration);
  try {
    await run(() => limiter(id, definition).block(limitKey(id, rawKey), duration));
  } catch (error) {
    logger.warn({ limiter: id, err: (error as Error).message }, "rate limiter block skipped");
  }
}

/** Forgets a key (successful login clears the failure counters of that account + IP). */
export async function resetLimit(id: RateLimitId, rawKey: string, definition: RateLimitDefinition = RATE_LIMITS[id]): Promise<void> {
  try {
    await run(() => limiter(id, definition).delete(limitKey(id, rawKey)));
  } catch {
    // Best effort.
  }
}

/** Tests only: drop every limiter (memory state included). */
export function resetLimiterStore(): void {
  limiters.clear();
  connecting = undefined;
  unavailableLoggedAt.clear();
}
