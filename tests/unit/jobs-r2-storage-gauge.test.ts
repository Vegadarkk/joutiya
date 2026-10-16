import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// r2-storage-gauge (03:10 UTC, D15): the sum of the ready uploads replaces the Valkey counter and
// the gauge becomes that sum + R2_STORAGE_BASELINE_BYTES.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/db/repositories/uploads", () => ({ sumReadyBytes: vi.fn(async () => 2_500_000_000) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({
  readMediaBytes: vi.fn(async () => 2_400_000_000),
  resetMediaBytes: vi.fn(async (total: number) => ({ id: "r2.storage", period: "2026-10-16", used: total + 4_140_000_000, limit: 10_000_000_000, ratio: 0.664, level: "ok" })),
}));

const { sumReadyBytes } = await import("@/lib/db/repositories/uploads");
const { readMediaBytes, resetMediaBytes } = await import("@/lib/uploads/storage-gauge");
const { resetServerEnv } = await import("@/lib/env");
const { r2StorageGauge } = await import("@/worker/jobs/r2-storage-gauge");

const NOW = new Date("2026-10-16T03:10:00Z");

beforeEach(() => {
  configured.value = true;
  delete process.env.R2_STORAGE_BASELINE_BYTES;
  resetServerEnv();
  vi.mocked(sumReadyBytes).mockClear();
  vi.mocked(resetMediaBytes).mockClear();
});

afterEach(() => {
  delete process.env.R2_STORAGE_BASELINE_BYTES;
  resetServerEnv();
});

describe("r2-storage-gauge", () => {
  it("recounts the ready uploads, replaces the counter and reports the account total", async () => {
    expect(await r2StorageGauge(NOW)).toEqual({ mediaBytes: 2_500_000_000, baselineBytes: 4_140_000_000, totalBytes: 6_640_000_000, counterBefore: 2_400_000_000, level: "ok" });
    expect(sumReadyBytes).toHaveBeenCalledTimes(1);
    expect(resetMediaBytes).toHaveBeenCalledWith(2_500_000_000, NOW);
  });

  it("uses the configured baseline and reports an unknown level without Valkey", async () => {
    process.env.R2_STORAGE_BASELINE_BYTES = "1000";
    resetServerEnv();
    vi.mocked(resetMediaBytes).mockResolvedValueOnce(null);
    vi.mocked(readMediaBytes).mockResolvedValueOnce(null);
    expect(await r2StorageGauge(NOW)).toEqual({ mediaBytes: 2_500_000_000, baselineBytes: 1000, totalBytes: 2_500_001_000, counterBefore: null, level: "unknown" });
  });

  it("skips without Firebase", async () => {
    configured.value = false;
    expect(await r2StorageGauge(NOW)).toBeNull();
    expect(sumReadyBytes).not.toHaveBeenCalled();
  });
});
