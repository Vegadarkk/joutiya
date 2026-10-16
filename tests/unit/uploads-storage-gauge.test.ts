import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R2 storage gauge (D15): running byte counter of the media bucket in valkey-queue, the retained
// backups' bytes, the r2.storage gauge = media + backups + map tiles reserve (64 MB) +
// R2_STORAGE_BASELINE_BYTES (alert at 8 GB, degraded at 9.5 GB), and the storage_full decision of
// the sign route. Real quota module over a fake Valkey.

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
const { BACKUP_BYTES_KEY, MAP_TILES_RESERVE_BYTES, MEDIA_BYTES_KEY, isStorageFull, readBackupBytes, readMediaBytes, recordMediaBytes, resetMediaBytes, setBackupBytes } = await import("@/lib/uploads/storage-gauge");

const AT = new Date("2026-10-16T10:00:00Z");
const GB = 1_000_000_000;
const gaugeKey = "quota:r2.storage:2026-10-16";
/** Baseline (4.14 GB by default) + map tiles reserve. */
const FLOOR = 4_140_000_000 + 64_000_000;

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
  it("moves the running counter and sets the gauge to counter + map reserve + baseline (4.14 GB by default)", async () => {
    expect(MAP_TILES_RESERVE_BYTES).toBe(64_000_000);
    const first = await recordMediaBytes(300_000, AT);
    expect(data.get(MEDIA_BYTES_KEY)).toBe("300000");
    expect(data.get(gaugeKey)).toBe(String(FLOOR + 300_000));
    expect(first).toMatchObject({ id: "r2.storage", level: "ok", used: FLOOR + 300_000 });

    await recordMediaBytes(-100_000, AT);
    expect(await readMediaBytes()).toBe(200_000);
    expect(data.get(gaugeKey)).toBe(String(FLOOR + 200_000));
  });

  it("adds the retained backups recorded in valkey-queue", async () => {
    data.set(BACKUP_BYTES_KEY, "50000000");
    await recordMediaBytes(300_000, AT);
    expect(data.get(gaugeKey)).toBe(String(FLOOR + 50_000_000 + 300_000));
  });

  it("never lets a negative drift lower the gauge under the baseline", async () => {
    await recordMediaBytes(-5_000, AT);
    expect(data.get(gaugeKey)).toBe(String(FLOOR));
  });

  it("alerts once at 8 GB and degrades at 9.5 GB (uploads refused)", async () => {
    process.env.R2_STORAGE_BASELINE_BYTES = String(7 * GB - MAP_TILES_RESERVE_BYTES);
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
    expect(data.get(gaugeKey)).toBe(String(FLOOR + 123_456));
    expect(status).toMatchObject({ used: FLOOR + 123_456, level: "ok" });
  });
});

describe("setBackupBytes", () => {
  it("replaces the backup bytes and refreshes the gauge with the media counter", async () => {
    await resetMediaBytes(1_000, AT);
    const status = await setBackupBytes(200_000_000, AT);
    expect(data.get(BACKUP_BYTES_KEY)).toBe("200000000");
    expect(await readBackupBytes()).toBe(200_000_000);
    expect(status).toMatchObject({ used: FLOOR + 200_000_000 + 1_000 });
    // The media recount keeps counting them.
    await resetMediaBytes(2_000, AT);
    expect(data.get(gaugeKey)).toBe(String(FLOOR + 200_000_000 + 2_000));
  });

  it("stores the value but leaves the gauge alone while the media counter is unknown (Valkey reset)", async () => {
    expect(await setBackupBytes(5_000, AT)).toBeNull();
    expect(data.get(BACKUP_BYTES_KEY)).toBe("5000");
    expect(data.has(gaugeKey)).toBe(false);
  });

  it("does nothing without Valkey and never throws", async () => {
    configured.value = false;
    expect(await setBackupBytes(5_000, AT)).toBeNull();
    expect(await readBackupBytes()).toBeNull();
    configured.value = true;
    broken.value = true;
    expect(await setBackupBytes(5_000, AT)).toBeNull();
    expect(await readBackupBytes()).toBeNull();
  });
});

describe("isStorageFull", () => {
  it("reads the running counter when the daily gauge key is still empty (after midnight UTC)", async () => {
    // Baseline 4.14 GB + 64 MB of map tiles: degraded from 9.5 GB, i.e. 5.296 GB of photos.
    data.set(MEDIA_BYTES_KEY, String(5_290_000_000));
    expect(await isStorageFull()).toBe(false);
    data.set(MEDIA_BYTES_KEY, String(5_300_000_000));
    expect(data.has(gaugeKey)).toBe(false);
    expect(await isStorageFull()).toBe(true);
  });

  it("counts the retained backups too", async () => {
    data.set(MEDIA_BYTES_KEY, String(5_000_000_000));
    expect(await isStorageFull()).toBe(false);
    data.set(BACKUP_BYTES_KEY, String(300_000_000));
    expect(await isStorageFull()).toBe(true);
  });

  it("lets uploads through when Valkey cannot answer (nothing known)", async () => {
    configured.value = false;
    expect(await isStorageFull()).toBe(false);
  });

  it("also refuses uploads once R2 Class A operations are degraded (95 % of the month)", async () => {
    data.set("quota:r2.classA:2026-10", String(960_000));
    expect(await isStorageFull()).toBe(true);
  });
});
