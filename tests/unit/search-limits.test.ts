import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS } from "@/config/rate-limits";
import { resetServerEnv } from "@/lib/env";
import type { HttpError } from "@/lib/http/errors";
import type * as Turnstile from "@/lib/security/turnstile";

// Search limits (design D13) on the in-memory limiter: device (or account) and IP buckets, the
// Turnstile escalation through the x-turnstile-token header, the 30-minute pass and its own
// allowance, the failed-token budget, and the open policy when valkey-ratelimit is down.

const mocks = vi.hoisted(() => ({
  viewer: null as { user: { uid: string } } | null,
  verify: vi.fn(async () => ({ ok: true, codes: [] as string[] })),
}));

vi.mock("@/lib/auth/guards", () => ({ optionalUser: vi.fn(async () => mocks.viewer) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: mocks.verify,
}));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { consumeLimit, resetRateLimiters } from "@/lib/rate-limit/limiter";
import { challengePassCookie } from "@/lib/security/challenge-pass";
import { newDeviceCookie } from "@/lib/security/device";
import { enforceSearchLimit } from "@/lib/search/limits";

let ipCounter = 0;
const freshIp = () => `10.77.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;

interface Client {
  ip: string;
  device: { id: string; value: string };
  pass?: string;
}

const client = (): Client => ({ ip: freshIp(), device: newDeviceCookie() });

function request(who: Client, headers: Record<string, string> = {}): Request {
  const cookies = [`__Host-did=${who.device.value}`, ...(who.pass ? [who.pass] : [])].join("; ");
  return new Request("http://localhost:3000/api/search?q=velo", { headers: { "x-forwarded-for": who.ip, cookie: cookies, ...headers } });
}

async function spend(id: keyof typeof RATE_LIMITS, key: string, keep = 0): Promise<void> {
  const points = RATE_LIMITS[id].points - keep;
  if (points > 0) await consumeLimit(id, key, points);
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  process.env.APP_ENV = "dev";
  delete process.env.RATE_LIMIT_REDIS_URL;
  resetServerEnv();
  resetRateLimiters();
  mocks.viewer = null;
  mocks.verify.mockClear();
  mocks.verify.mockResolvedValue({ ok: true, codes: [] });
});

afterEach(() => resetServerEnv());

describe("enforceSearchLimit", () => {
  it("lets a client through within its device and IP budgets", async () => {
    const who = client();
    for (let i = 0; i < RATE_LIMITS["search.device.minute"].points; i += 1) await expect(enforceSearchLimit(request(who))).resolves.toEqual({ passGranted: false });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("asks for Turnstile past the device budget, then grants a pass for a solved token", async () => {
    const who = client();
    await spend("search.device.minute", `d:${who.device.id}`);
    const error = await rejection(enforceSearchLimit(request(who)));
    expect([error.status, error.code]).toEqual([403, "turnstile_required"]);

    await expect(enforceSearchLimit(request(who, { "x-turnstile-token": "solved" }))).resolves.toEqual({ passGranted: true });
    expect(mocks.verify).toHaveBeenCalledWith("solved", { action: "search", remoteIp: who.ip, hostname: "localhost" });
  });

  it("allows the pass's own budget, then answers 429 with Retry-After", async () => {
    const who = client();
    who.pass = (await challengePassCookie(who.device.id)).split(";")[0];
    await spend("search.device.hour", `d:${who.device.id}`);
    await spend("search.passed.device", `d:${who.device.id}`, 1);
    await expect(enforceSearchLimit(request(who))).resolves.toEqual({ passGranted: false });

    const error = await rejection(enforceSearchLimit(request(who)));
    expect([error.status, error.code]).toEqual([429, "rate_limited"]);
    expect(Number(error.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("escalates past the IP budget too, whatever the device", async () => {
    const who = client();
    await spend("search.ip", who.ip);
    expect((await rejection(enforceSearchLimit(request({ ...who, device: newDeviceCookie() })))).code).toBe("turnstile_required");
  });

  it("ignores a pass bound to another device", async () => {
    const who = client();
    who.pass = (await challengePassCookie(newDeviceCookie().id)).split(";")[0];
    await spend("search.device.minute", `d:${who.device.id}`);
    expect((await rejection(enforceSearchLimit(request(who)))).code).toBe("turnstile_required");
  });

  it("keys a signed-in member on the account: a new device does not reset the budget", async () => {
    mocks.viewer = { user: { uid: "uid-search-1" } };
    await spend("search.device.minute", "u:uid-search-1");
    expect((await rejection(enforceSearchLimit(request(client())))).code).toBe("turnstile_required");
    mocks.viewer = null;
    await expect(enforceSearchLimit(request(client()))).resolves.toEqual({ passGranted: false });
  });

  it("refuses a bad token, then stops calling siteverify once the IP spent its failure budget", async () => {
    const who = client();
    await spend("search.device.minute", `d:${who.device.id}`);
    mocks.verify.mockResolvedValue({ ok: false, codes: ["invalid-input-response"] });
    const failed = await rejection(enforceSearchLimit(request(who, { "x-turnstile-token": "bad" })));
    expect([failed.status, failed.code, failed.details]).toEqual([403, "turnstile_failed", { codes: ["invalid-input-response"] }]);

    await spend("challenge.ip", who.ip, 1);
    mocks.verify.mockClear();
    const limited = await rejection(enforceSearchLimit(request(who, { "x-turnstile-token": "bad" })));
    expect([limited.status, limited.code]).toEqual([429, "rate_limited"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("still checks the first token of another device when the shared IP spent its failure budget", async () => {
    const who = client();
    await spend("challenge.ip", who.ip);
    await spend("search.ip", who.ip);
    await expect(enforceSearchLimit(request(who, { "x-turnstile-token": "solved" }))).resolves.toEqual({ passGranted: true });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

  it("stops calling siteverify for a device past its own failure budget", async () => {
    const who = client();
    await spend("search.device.minute", `d:${who.device.id}`);
    await spend("challenge.device", `d:${who.device.id}`);
    const limited = await rejection(enforceSearchLimit(request(who, { "x-turnstile-token": "bad" })));
    expect([limited.status, limited.code]).toEqual([429, "rate_limited"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("stays open when the limiter store is down", async () => {
    const down = { ok: false, reason: "unavailable" } as const;
    vi.mocked(consumeLimit).mockResolvedValueOnce(down).mockResolvedValueOnce(down).mockResolvedValueOnce(down);
    await expect(enforceSearchLimit(request(client()))).resolves.toEqual({ passGranted: false });
    expect(consumeLimit).toHaveBeenCalledTimes(3);
  });

  it("keys a client without device cookie on its IP bucket", async () => {
    const ip = freshIp();
    await spend("search.device.minute", `anon:${ip}`);
    const anonymous = new Request("http://localhost:3000/api/search", { headers: { "x-forwarded-for": ip } });
    expect((await rejection(enforceSearchLimit(anonymous))).code).toBe("turnstile_required");
  });
});
