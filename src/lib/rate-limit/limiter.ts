import "server-only";
import type { RateLimitOverrides } from "@/config/abuse";
import { RATE_LIMITS, type RateLimitDefinition, type RateLimitId } from "@/config/rate-limits";
import { getAbuse } from "@/lib/config/runtime";
import { HttpError, rateLimited, unavailable } from "@/lib/http/errors";
import * as core from "./core";
import type { LimitOutcome, LimitState } from "./core";

export { limitKey } from "./core";
export type { LimitOutcome, LimitState };

// Rate limits of the API and the server pages (§6): the RATE_LIMITS table under the private
// overrides of Firestore `config/abuse` `rateLimits` (points, duration, blockDuration by id; the
// policy and the key stay the committed ones). The store calls are in core.ts. The overrides come
// from the 5-minute config cache and are never waited on for more than OVERRIDES_WAIT_MS: a slow or
// unreachable Firestore leaves the last known values (then the committed ones), never a slow limiter.
// The proxy's page limits (proxy-limits.ts) use core.ts directly, on the committed values.

const OVERRIDES_WAIT_MS = 250;
let known: RateLimitOverrides = {};
/** Bounded wait on the read in flight, shared by concurrent callers; undefined when no read is in flight. */
let waiting: Promise<void> | undefined;

async function overrides(): Promise<RateLimitOverrides> {
  if (!waiting) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = getAbuse().then(
      (config) => {
        known = config.rateLimits;
      },
      () => undefined,
    );
    const bounded = Promise.race([read, new Promise<void>((resolve) => (timer = setTimeout(resolve, OVERRIDES_WAIT_MS)))]).finally(() => clearTimeout(timer));
    waiting = bounded;
    // A hanging read is waited on once: later callers go on at once with the known values.
    void read.finally(() => {
      if (waiting === bounded) waiting = undefined;
    });
  }
  await waiting;
  return known;
}

/** `RATE_LIMITS[id]` under an override of config/abuse. Pure. */
export function applyRateLimitOverride(id: RateLimitId, override: RateLimitOverrides[RateLimitId]): RateLimitDefinition {
  const base: RateLimitDefinition = RATE_LIMITS[id];
  if (!override) return base;
  return { ...base, ...(override.points !== undefined ? { points: override.points } : {}), ...(override.duration !== undefined ? { duration: override.duration } : {}), ...(override.blockDuration !== undefined ? { blockDuration: override.blockDuration } : {}) };
}

/** The definition applied to `id` now (committed values under the config/abuse overrides). */
export async function rateLimitDefinition(id: RateLimitId): Promise<RateLimitDefinition> {
  return applyRateLimitOverride(id, (await overrides())[id]);
}

/** Consumes `points` for `rawKey`. Never throws: the outcome carries the decision. */
export async function consumeLimit(id: RateLimitId, rawKey: string, points = 1): Promise<LimitOutcome> {
  return core.consumeLimit(id, rawKey, points, await rateLimitDefinition(id));
}

/** Consumed points and the time left on `rawKey`, or null when the store cannot answer. */
export async function limitState(id: RateLimitId, rawKey: string): Promise<LimitState | null> {
  return core.limitState(id, rawKey, await rateLimitDefinition(id));
}

/** Points already consumed for `rawKey` in the current window (0 when none, null when unknown). */
export async function consumedPoints(id: RateLimitId, rawKey: string): Promise<number | null> {
  const state = await limitState(id, rawKey);
  return state ? state.consumedPoints : null;
}

/**
 * Blocks `rawKey` for `seconds` (the definition's blockDuration, else its window) from now: the
 * store marks the key as exhausted whatever its count. Best effort, like resetLimit.
 */
export async function blockLimit(id: RateLimitId, rawKey: string, seconds?: number): Promise<void> {
  return core.blockLimit(id, rawKey, seconds, await rateLimitDefinition(id));
}

/** Forgets a key (successful login clears the failure counters of that account + IP). */
export async function resetLimit(id: RateLimitId, rawKey: string): Promise<void> {
  return core.resetLimit(id, rawKey, await rateLimitDefinition(id));
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

/** Tests only: drop every limiter (memory state included) and the known overrides. */
export function resetRateLimiters(): void {
  core.resetLimiterStore();
  known = {};
  waiting = undefined;
}
