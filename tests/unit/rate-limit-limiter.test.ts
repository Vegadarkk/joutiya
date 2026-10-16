import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RateLimiterFlexible from "rate-limiter-flexible";
import { RATE_LIMITS } from "@/config/rate-limits";
import { resetServerEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import { blockLimit, consumeLimit, enforceLimit, limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";

// Limiter policies with the store down (§6): "closed" refuses with 503, "open" lets the request
// through, and a store that hangs counts as down after the 500 ms command timeout.

const store = vi.hoisted(() => ({
  consume: vi.fn<() => Promise<unknown>>(),
  get: vi.fn<() => Promise<unknown>>(),
  block: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => Boolean(process.env.RATE_LIMIT_REDIS_URL), valkey: () => ({}) }));
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimiterFlexible>();
  class StubRedisLimiter {
    consume = store.consume;
    get = store.get;
    block = store.block;
    delete = async () => true;
  }
  return { ...actual, RateLimiterRedis: StubRedisLimiter };
});

const down = () => Promise.reject(new Error("Redis connection is not ready"));

beforeEach(() => {
  process.env.APP_ENV = "dev";
  process.env.RATE_LIMIT_REDIS_URL = "redis://stub";
  resetServerEnv();
  resetRateLimiters();
});

afterEach(() => {
  delete process.env.RATE_LIMIT_REDIS_URL;
  resetServerEnv();
  vi.useRealTimers();
});

describe("rate limiter with the store down", () => {
  it("reports the store as unavailable without throwing", async () => {
    store.consume.mockImplementation(down);
    await expect(consumeLimit("login.ip", "1.2.3.4")).resolves.toEqual({ ok: false, reason: "unavailable" });
    store.get.mockImplementation(down);
    await expect(limitState("login.fail.account", "k")).resolves.toBeNull();
    store.block.mockImplementation(down);
    await expect(blockLimit("login.fail.accountIp", "k")).resolves.toBeUndefined();
  });

  it("refuses with 503 under a closed policy and passes under an open one", async () => {
    store.consume.mockImplementation(down);
    expect(RATE_LIMITS["signup.ip"].policy).toBe("closed");
    await expect(enforceLimit("signup.ip", "1.2.3.4")).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(RATE_LIMITS["clientToken.uid"].policy).toBe("open");
    await expect(enforceLimit("clientToken.uid", "uid")).resolves.toBeUndefined();
  });

  it("treats a store that hangs as down after the command timeout", async () => {
    vi.useFakeTimers();
    store.consume.mockImplementation(() => new Promise(() => undefined));
    const pending = enforceLimit("reset.ip", "1.2.3.4");
    const settled = pending.then(
      () => "passed",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(store.consume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(503);
  });

  it("still answers 429 when the store rejects with a limiter result", async () => {
    const { RateLimiterRes } = await import("rate-limiter-flexible");
    store.consume.mockImplementation(() => Promise.reject(new RateLimiterRes(0, 42_000, 31, false)));
    await expect(enforceLimit("signup.ip", "1.2.3.4")).rejects.toMatchObject({ status: 429, code: "rate_limited", headers: { "Retry-After": "42" } });
  });
});

describe("in-memory limiter (no store configured)", () => {
  beforeEach(() => {
    delete process.env.RATE_LIMIT_REDIS_URL;
    resetServerEnv();
    resetRateLimiters();
  });

  it("blocks a key for the configured blockDuration and reports the time left", async () => {
    vi.useFakeTimers();
    const definition = RATE_LIMITS["login.fail.accountIp"];
    for (let i = 0; i < definition.points; i += 1) expect((await consumeLimit("login.fail.accountIp", "acct:ip")).ok).toBe(true);
    await blockLimit("login.fail.accountIp", "acct:ip");
    const state = await limitState("login.fail.accountIp", "acct:ip");
    expect(state?.consumedPoints).toBeGreaterThanOrEqual(definition.points);
    expect(state?.msBeforeNext).toBe(definition.blockDuration * 1000);
    await vi.advanceTimersByTimeAsync(definition.blockDuration * 1000 + 1);
    expect(await limitState("login.fail.accountIp", "acct:ip")).toEqual({ consumedPoints: 0, msBeforeNext: 0 });
  });
});
