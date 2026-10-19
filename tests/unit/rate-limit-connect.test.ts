import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RateLimiterFlexible from "rate-limiter-flexible";
import { resetServerEnv } from "@/lib/env";
import { consumeLimit, resetRateLimiters } from "@/lib/rate-limit/limiter";

// The ratelimit client is lazy (lazyConnect) and rate-limiter-flexible refuses every call while it
// is not "ready" (rejectIfRedisNotReady): the limiter connects it first (research §1, design D14).

const client = vi.hoisted(() => ({
  status: "wait" as string,
  connect: vi.fn<() => Promise<void>>(),
}));
const store = vi.hoisted(() => ({ consume: vi.fn<() => Promise<unknown>>() }));

vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => true, valkey: () => client }));
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimiterFlexible>();
  class StubRedisLimiter {
    // Mirrors _isRedisReady: refuses unless the client is ready.
    consume = (...args: unknown[]) => (client.status === "ready" ? store.consume(...(args as [])) : Promise.reject(new Error("Redis connection is not ready")));
  }
  return { ...actual, RateLimiterRedis: StubRedisLimiter };
});

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
  resetRateLimiters();
  client.status = "wait";
  client.connect.mockReset();
  store.consume.mockReset();
  store.consume.mockResolvedValue({ remainingPoints: 9 });
});
afterEach(() => resetServerEnv());

describe("rate limiter store connection", () => {
  it("connects a lazy client before the first command, once for concurrent callers", async () => {
    client.connect.mockImplementation(async () => {
      client.status = "connecting";
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.status = "ready";
    });
    const outcomes = await Promise.all([consumeLimit("pages.ip", "1.2.3.4"), consumeLimit("pages.ip", "1.2.3.5"), consumeLimit("pages.device", "d:x")]);
    expect(outcomes).toEqual([
      { ok: true, remaining: 9 },
      { ok: true, remaining: 9 },
      { ok: true, remaining: 9 },
    ]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await consumeLimit("pages.ip", "1.2.3.4");
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("reports the store as unavailable when the connection fails (open policies pass)", async () => {
    client.connect.mockImplementation(async () => {
      client.status = "reconnecting";
      throw new Error("ECONNREFUSED");
    });
    await expect(consumeLimit("pages.ip", "1.2.3.4")).resolves.toEqual({ ok: false, reason: "unavailable" });
    // Later calls do not wait for another attempt: ioredis reconnects in the background.
    await expect(consumeLimit("pages.ip", "1.2.3.4")).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps the 500 ms budget when connecting hangs", async () => {
    client.connect.mockImplementation(() => {
      client.status = "connecting";
      return new Promise<void>(() => undefined);
    });
    const started = Date.now();
    await expect(consumeLimit("pages.ip", "1.2.3.4")).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
