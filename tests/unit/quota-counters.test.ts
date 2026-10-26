import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

// Fake valkey-queue: SET with NX, GET, MGET and the INCRBY+EXPIRE multi that consume() uses.
const store = new Map<string, string>();
const broken = { value: false };
const fake = {
  set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
    if (args.includes("NX") && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  mget: vi.fn(async (keys: string[]) => keys.map((key) => store.get(key) ?? null)),
  multi: () => {
    const ops: (() => number)[] = [];
    const chain = {
      incrby(key: string, amount: number) {
        ops.push(() => {
          const next = Number(store.get(key) ?? 0) + amount;
          store.set(key, String(next));
          return next;
        });
        return chain;
      },
      expire() {
        ops.push(() => 1);
        return chain;
      },
      async exec() {
        if (broken.value) throw new Error("connection closed");
        return ops.map((op) => [null, op()]);
      },
    };
    return chain;
  },
};
const configured = { value: true };
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => configured.value, valkey: () => fake }));

const { alert } = await import("@/lib/alert");
const { aggregationReads, consume, firstDegraded, headroom, isDegraded, isExhausted, nextReset, raiseTo, readQuotas, setGauge } = await import("@/lib/quota");

const AT = new Date("2026-10-16T10:00:00Z");
const TOMORROW = new Date("2026-10-17T10:00:00Z");

beforeEach(() => {
  store.clear();
  broken.value = false;
  configured.value = true;
  vi.mocked(alert).mockClear();
  fake.set.mockClear();
});

describe("consume", () => {
  it("counts per period and alerts once per level and period (resend.daily: 80 a day, the uptime Worker keeps 20)", async () => {
    expect(await consume("resend.daily", 55, AT)).toMatchObject({ id: "resend.daily", period: "2026-10-16", used: 55, limit: 80, level: "ok" });
    expect(alert).not.toHaveBeenCalled();

    // 70 %: one P2, not repeated by the next increments.
    expect(await consume("resend.daily", 1, AT)).toMatchObject({ used: 56, ratio: 0.7, level: "warning" });
    expect(await consume("resend.daily", 1, AT)).toMatchObject({ used: 57, level: "warning" });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: expect.stringContaining("70 %") }));
    expect(vi.mocked(alert).mock.calls[0]?.[0].title).toContain("resend.daily");
    expect(vi.mocked(alert).mock.calls[0]?.[0].body).toContain("56 / 80 emails pour 2026-10-16");

    // 90 %: the degraded level, one P1 with the degraded mode.
    expect(await consume("resend.daily", 15, AT)).toMatchObject({ used: 72, level: "degraded" });
    expect(await consume("resend.daily", 4, AT)).toMatchObject({ used: 76, level: "degraded" });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.calls[1]?.[0]).toMatchObject({ severity: "P1", title: expect.stringContaining("mode dégradé") });
    expect(vi.mocked(alert).mock.calls[1]?.[0].body).toContain("Seuls les e-mails de sécurité");
    expect(fake.set).toHaveBeenCalledWith("quota:alerted:resend.daily:2026-10-16:warning", "1", "EX", expect.any(Number), "NX");

    // A new period starts from zero and alerts again.
    expect(await consume("resend.daily", 56, TOMORROW)).toMatchObject({ period: "2026-10-17", used: 56, level: "warning" });
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it("reports unknown, without throwing, when Valkey is missing or down", async () => {
    configured.value = false;
    expect(await consume("resend.daily", 1, AT)).toMatchObject({ used: 0, level: "unknown" });
    expect(await isDegraded("resend.daily")).toBe(false);
    expect((await readQuotas(AT)).every((quota) => quota.level === "unknown")).toBe(true);
    configured.value = true;
    broken.value = true;
    expect(await consume("resend.daily", 1, AT)).toMatchObject({ level: "unknown" });
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("isDegraded and isExhausted", () => {
  it("separate the degraded mode (90 %) from the exhausted counter (100 %)", async () => {
    expect(await isDegraded("resend.daily")).toBe(false);
    expect(await isExhausted("resend.daily")).toBe(false);
    await consume("resend.daily", 72);
    expect(await isDegraded("resend.daily")).toBe(true);
    expect(await isExhausted("resend.daily")).toBe(false);
    await consume("resend.daily", 8);
    expect(await isExhausted("resend.daily")).toBe(true);
    // Brevo degrades at 100 %: both flip together.
    await consume("brevo.daily", 299);
    expect(await isDegraded("brevo.daily")).toBe(false);
    await consume("brevo.daily", 1);
    expect(await isDegraded("brevo.daily")).toBe(true);
    expect(await isExhausted("brevo.daily")).toBe(true);
  });

  it("read gauges too, and readQuotas lists every counter of the period", async () => {
    await setGauge("r2.storage", 9.6 * 1_000_000_000);
    expect(await isDegraded("r2.storage")).toBe(true);
    expect(await isExhausted("r2.storage")).toBe(false);
    const quotas = await readQuotas();
    expect(quotas.find((quota) => quota.id === "r2.storage")).toMatchObject({ level: "degraded", used: 9_600_000_000 });
    expect(quotas.find((quota) => quota.id === "claude.budget")).toMatchObject({ used: 0, level: "ok" });
    // A gauge nobody measured this period is unknown, not a false 0 at "ok".
    expect(quotas.find((quota) => quota.id === "firestore.storage")).toMatchObject({ used: 0, level: "unknown" });
  });

  it("alert the Firestore storage estimate once a month, though the backup sets it every night", async () => {
    expect(await setGauge("firestore.storage", 700_000_000, AT)).toMatchObject({ period: "2026-10", level: "warning" });
    expect(await setGauge("firestore.storage", 710_000_000, TOMORROW)).toMatchObject({ period: "2026-10", level: "warning" });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alert).mock.calls[0]?.[0].title).toContain("firestore.storage");
    expect((await readQuotas(TOMORROW)).find((quota) => quota.id === "firestore.storage")).toMatchObject({ used: 710_000_000, level: "warning" });
    expect(await setGauge("firestore.storage", 720_000_000, new Date("2026-11-01T03:30:00Z"))).toMatchObject({ period: "2026-11", level: "warning" });
    expect(alert).toHaveBeenCalledTimes(2);
  });
});

describe("firstDegraded and headroom", () => {
  it("name the first degraded quota of a list in one MGET, unknown counting as available", async () => {
    fake.mget.mockClear();
    expect(await firstDegraded(["firestore.writes", "firestore.storage"])).toBeNull();
    await consume("firestore.writes", 19_999);
    expect(await firstDegraded(["firestore.writes", "firestore.storage"])).toBeNull();
    await consume("firestore.writes", 1);
    await setGauge("firestore.storage", 1_000_000_000);
    expect(await firstDegraded(["firestore.writes", "firestore.storage"])).toBe("firestore.writes");
    expect(await firstDegraded(["firestore.reads", "firestore.storage"])).toBe("firestore.storage");
    expect(fake.mget).toHaveBeenCalledTimes(4);
    expect(await firstDegraded([])).toBeNull();
    configured.value = false;
    expect(await firstDegraded(["firestore.writes"])).toBeNull();
    configured.value = true;
    fake.mget.mockRejectedValueOnce(new Error("connection closed"));
    expect(await firstDegraded(["firestore.writes"])).toBeNull();
  });

  it("is what is left below a share of the limit, never negative, null when unreadable", async () => {
    expect(await headroom("firestore.deletes", 0.9)).toBe(18_000);
    await consume("firestore.deletes", 15_000);
    expect(await headroom("firestore.deletes", 0.9)).toBe(3_000);
    expect(await headroom("firestore.deletes")).toBe(5_000);
    await consume("firestore.deletes", 4_000);
    expect(await headroom("firestore.deletes", 0.9)).toBe(0);
    configured.value = false;
    expect(await headroom("firestore.deletes", 0.9)).toBeNull();
    configured.value = true;
    fake.get.mockRejectedValueOnce(new Error("connection closed"));
    expect(await headroom("firestore.deletes", 0.9)).toBeNull();
  });
});

describe("raiseTo", () => {
  it("lifts a counter to the provider's higher count, never lowers it, and alerts on the crossing", async () => {
    // Today's period (isDegraded reads the current one), like the increments of a real send.
    await consume("resend.daily", 10);
    // Resend's header counts the uptime Worker's relay mails too: the local counter catches up.
    expect(await raiseTo("resend.daily", 30)).toMatchObject({ used: 30, level: "ok" });
    expect(await consume("resend.daily", 1)).toMatchObject({ used: 31 });
    // A lower provider value (another day's header, a stale read) changes nothing.
    expect(await raiseTo("resend.daily", 20)).toMatchObject({ used: 31, level: "ok" });
    expect(await raiseTo("resend.daily", 31)).toMatchObject({ used: 31 });
    expect(alert).not.toHaveBeenCalled();
    expect(fake.set).toHaveBeenCalledWith(expect.stringMatching(/^quota:resend\.daily:\d{4}-\d{2}-\d{2}$/), "30", "EX", expect.any(Number));
    // The raise crosses 90 %: the same P1 as an increment would have raised, once.
    expect(await raiseTo("resend.daily", 75)).toMatchObject({ used: 75, level: "degraded" });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ severity: "P1", title: expect.stringContaining("resend.daily") });
    expect(await isDegraded("resend.daily")).toBe(true);
    // An unset counter starts at the provider's value.
    expect(await raiseTo("resend.monthly", 1_200, AT)).toMatchObject({ period: "2026-10", used: 1_200, level: "ok" });
  });

  it("reports unknown, without throwing, when Valkey is missing or down", async () => {
    configured.value = false;
    expect(await raiseTo("resend.daily", 50, AT)).toMatchObject({ used: 0, level: "unknown" });
    configured.value = true;
    fake.get.mockRejectedValueOnce(new Error("connection closed"));
    expect(await raiseTo("resend.daily", 50, AT)).toMatchObject({ level: "unknown" });
    expect(store.has("quota:resend.daily:2026-10-16")).toBe(false);
  });
});

describe("aggregationReads", () => {
  it("bills one read per 1 000 index entries, at least one", () => {
    expect([0, 1, 1_000, 1_001, 25_000].map(aggregationReads)).toEqual([1, 1, 1, 2, 25]);
  });
});

describe("nextReset", () => {
  it("is the provider's next reset: UTC midnight, the Pacific midnight for Firestore, the next month", () => {
    const at = new Date("2026-10-13T05:00:00Z");
    const near = (date: Date, iso: string) => {
      expect(date.getTime()).toBeGreaterThanOrEqual(Date.parse(iso));
      expect(date.getTime()).toBeLessThanOrEqual(Date.parse(iso) + 1_000);
    };
    near(nextReset("resend.daily", at), "2026-10-14T00:00:00Z");
    near(nextReset("brevo.daily", at), "2026-10-14T00:00:00Z");
    // Los Angeles is on PDT (UTC-7) in October: the day resets at 07:00 UTC.
    near(nextReset("firestore.reads", at), "2026-10-13T07:00:00Z");
    near(nextReset("resend.monthly", at), "2026-11-01T00:00:00Z");
    near(nextReset("resend.monthly", new Date("2026-12-31T23:59:59Z")), "2027-01-01T00:00:00Z");
  });
});
