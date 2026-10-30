import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config/abuse at runtime: the stored document reaches the detectors and the rate limiter (limiter
// definitions rebuilt when an override changes), an invalid field raises a P1 alert, an unreachable
// Firestore keeps the last known value.

const store = vi.hoisted(() => ({ doc: undefined as Record<string, unknown> | undefined, fail: false, hang: false, reads: 0 }));
const alerts = vi.hoisted(() => [] as { severity: string; title: string }[]);

vi.mock("@/lib/firebase/admin", () => ({
  isFirestoreConfigured: () => true,
  db: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          store.reads += 1;
          if (store.hang) return new Promise<never>(() => undefined);
          if (store.fail) throw new Error("unreachable");
          const data = name === "config" && id === "abuse" ? store.doc : undefined;
          return { exists: data !== undefined, data: () => data };
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async (input: { severity: string; title: string }) => void alerts.push(input)) }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => undefined) }));

const { getAbuse, getAbuseRules } = await import("@/lib/config/runtime");
const { consumeLimit, rateLimitDefinition, resetRateLimiters } = await import("@/lib/rate-limit/limiter");
const { RATE_LIMITS } = await import("@/config/rate-limits");
const { containsProhibited } = await import("@/lib/moderation/prohibited");

beforeEach(() => {
  store.doc = undefined;
  store.fail = false;
  store.hang = false;
  store.reads = 0;
  alerts.length = 0;
  getAbuse.invalidate();
  resetRateLimiters();
});
afterEach(() => vi.useRealTimers());

describe("getAbuse", () => {
  it("serves the stored document over the defaults, cached", async () => {
    store.doc = { prohibited: { drugs: { hard: ["zorglub"] } } };
    const rules = await getAbuseRules();
    expect(containsProhibited("vends zorglub", rules.prohibited).hard).toEqual(["drugs"]);
    expect(await getAbuseRules()).toBe(rules);
    expect(store.reads).toBe(1);
  });

  it("alerts on an invalid field and keeps the valid ones", async () => {
    store.doc = { risk: { volumePerDay: 0, newAccountDays: 5 } };
    const config = await getAbuse();
    expect(config.risk).toMatchObject({ volumePerDay: 3, newAccountDays: 5 });
    expect(alerts).toEqual([expect.objectContaining({ severity: "P1", title: "Document config/abuse invalide" })]);
  });

  it("keeps the last known value when Firestore is unreachable", async () => {
    store.doc = { risk: { volumePerDay: 8 } };
    expect((await getAbuse()).risk.volumePerDay).toBe(8);
    getAbuse.invalidate();
    store.fail = true;
    expect((await getAbuse()).risk.volumePerDay).toBe(8);
  });
});

describe("rate-limit overrides", () => {
  it("applies the committed definition without a document", async () => {
    expect(await rateLimitDefinition("signup.device")).toEqual(RATE_LIMITS["signup.device"]);
  });

  it("overrides points, duration and blockDuration, never the policy or the key", async () => {
    store.doc = { rateLimits: { "login.fail.accountIp": { points: 2, blockDuration: 3600 } } };
    expect(await rateLimitDefinition("login.fail.accountIp")).toEqual({ ...RATE_LIMITS["login.fail.accountIp"], points: 2, blockDuration: 3600 });
  });

  it("enforces the overridden allowance and rebuilds the limiter when it changes", async () => {
    store.doc = { rateLimits: { "signup.device": { points: 1 } } };
    expect(await consumeLimit("signup.device", "device-a")).toEqual({ ok: true, remaining: 0 });
    expect(await consumeLimit("signup.device", "device-a")).toMatchObject({ ok: false, reason: "limited" });
    store.doc = { rateLimits: { "signup.device": { points: 5 } } };
    getAbuse.invalidate();
    // A memory limiter starts over when rebuilt (a Redis one keeps its counters under rl:{id}).
    expect(await consumeLimit("signup.device", "device-a")).toEqual({ ok: true, remaining: 4 });
  });

  it("never waits on a slow Firestore: the last known overrides apply", async () => {
    store.doc = { rateLimits: { "signup.device": { points: 7 } } };
    expect((await rateLimitDefinition("signup.device")).points).toBe(7);
    getAbuse.invalidate();
    vi.useFakeTimers();
    // A read that never answers: the limiter goes on after its wait with the known values.
    store.hang = true;
    const definition = rateLimitDefinition("signup.device");
    await vi.advanceTimersByTimeAsync(300);
    expect((await definition).points).toBe(7);
    // The hanging read is waited on once: the next calls neither wait nor read again.
    expect((await rateLimitDefinition("signup.device")).points).toBe(7);
    expect(store.reads).toBe(2);
  });
});
