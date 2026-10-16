import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R2 storage gauge (D15): running byte counter of the media bucket in valkey-queue, the r2.storage
// gauge = counter + R2_STORAGE_BASELINE_BYTES (alert at 8 GB, degraded at 9.5 GB), and the
// storage_full decision of the sign route. Real quota module over a fake Valkey.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

const data = new Map<string, string>();
const broken = { value: false };
const fake = {
  set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
    if (broken.value) throw new Error("connection closed");
    if (args.includes("NX") && data.has(key)) return null;
    data.set(key, value);
    return "OK";
  }),
  get: vi.fn(async (key: string) => {
    if (broken.value) throw new Error("connection closed");
    return data.get(key) ?? null;
  }),
  incrby: vi.fn(async (key: string, amount: number) => {
    if (broken.value) throw new Error("connection closed");
    const next = Number(data.get(key) ?? 0) + amount;
    data.set(key, String(next));
    return next;
  }),
};
const configured = { value: true };
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => configured.value, valkey: () => fake }));

const { alert } = await import("@/lib/alert");
const { resetServerEnv } = await import("@/lib/env");
const { MEDIA_BYTES_KEY, isStorageFull, readMediaBytes, recordMediaBytes, resetMediaBytes } = await import("@/lib/uploads/storage-gauge");

const AT = new Date("2026-10-16T10:00:00Z");
const GB = 1_000_000_000;
const gaugeKey = "quota:r2.storage:2026-10-16";

beforeEach(() => {
  data.clear();
  broken.value = false;
  configured.value = true;
  vi.mocked(alert).mockClear();
  delete process.env.R2_STORAGE_BASELINE_BYTES;
  resetServerEnv();
  // isDegraded reads the period of "now": pin it to AT.
  vi.useFakeTimers({ now: AT, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.R2_STORAGE_BASELINE_BYTES;
  resetServerEnv();
});

describe("recordMediaBytes", () => {
  it("moves the running counter and sets the gauge to counter + baseline (4.14 GB by default)", async () => {
    const first = await recordMediaBytes(300_000, AT);
    expect(data.get(MEDIA_BYTES_KEY)).toBe("300000");
    expect(data.get(gaugeKey)).toBe(String(4_140_000_000 + 300_000));
    expect(first).toMatchObject({ id: "r2.storage", level: "ok", used: 4_140_300_000 });

    await recordMediaBytes(-100_000, AT);
    expect(await readMediaBytes()).toBe(200_000);
    expect(data.get(gaugeKey)).toBe(String(4_140_200_000));
  });

  it("never lets a negative drift lower the gauge under the baseline", async () => {
    await recordMediaBytes(-5_000, AT);
    expect(data.get(gaugeKey)).toBe("4140000000");
  });

  it("alerts once at 8 GB and degrades at 9.5 GB (uploads refused)", async () => {
    process.env.R2_STORAGE_BASELINE_BYTES = String(7 * GB);
    resetServerEnv();
    expect(await isStorageFull()).toBe(false);
    expect(await recordMediaBytes(1.2 * GB, AT)).toMatchObject({ level: "warning" });
    await recordMediaBytes(1_000, AT);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await isStorageFull()).toBe(false);
    expect(await recordMediaBytes(1.4 * GB, AT)).toMatchObject({ level: "degraded" });
    expect(await isStorageFull()).toBe(true);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("does nothing without Valkey or for a zero delta, and never throws", async () => {
    expect(await recordMediaBytes(0, AT)).toBeNull();
    configured.value = false;
    expect(await recordMediaBytes(10, AT)).toBeNull();
    expect(await readMediaBytes()).toBeNull();
    expect(await isStorageFull()).toBe(false);
    configured.value = true;
    broken.value = true;
    expect(await recordMediaBytes(10, AT)).toBeNull();
    expect(await readMediaBytes()).toBeNull();
    // Unknown counts as available (the quota module's rule).
    expect(await isStorageFull()).toBe(false);
  });
});

describe("resetMediaBytes", () => {
  it("replaces the counter with the recount and refreshes the gauge", async () => {
    await recordMediaBytes(999_999, AT);
    const status = await resetMediaBytes(123_456, AT);
    expect(data.get(MEDIA_BYTES_KEY)).toBe("123456");
    expect(data.get(gaugeKey)).toBe(String(4_140_000_000 + 123_456));
    expect(status).toMatchObject({ used: 4_140_123_456, level: "ok" });
  });
});

describe("isStorageFull", () => {
  it("also refuses uploads once R2 Class A operations are degraded (95 % of the month)", async () => {
    data.set("quota:r2.classA:2026-10", String(960_000));
    expect(await isStorageFull()).toBe(true);
  });
});
