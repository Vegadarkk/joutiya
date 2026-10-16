import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// r2-storage-gauge (03:10 UTC, D15): the sum of the stored photos (ready uploads, and those deleted
// under a legal hold) replaces the Valkey counter, the encrypted backups still in the private bucket
// (98 days, from system/backup) replace theirs, and the gauge becomes media + backups + map tiles
// reserve + R2_STORAGE_BASELINE_BYTES.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn(() => ({ fake: "db" })) }));
vi.mock("@/lib/db/repositories/uploads", () => ({ sumStoredBytes: vi.fn(async () => 2_500_000_000) }));
vi.mock("@/lib/backup/export", () => ({ readRetainedBackupBytes: vi.fn(async () => 300_000_000) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({
  MAP_TILES_RESERVE_BYTES: 64_000_000,
  readMediaBytes: vi.fn(async () => 2_400_000_000),
  readBackupBytes: vi.fn(async () => 250_000_000),
  setBackupBytes: vi.fn(async () => null),
  resetMediaBytes: vi.fn(async (total: number) => ({ id: "r2.storage", period: "2026-10-16", used: total + 4_504_000_000, limit: 10_000_000_000, ratio: 0.7, level: "ok" })),
}));

const { sumStoredBytes } = await import("@/lib/db/repositories/uploads");
const { readRetainedBackupBytes } = await import("@/lib/backup/export");
const { readMediaBytes, resetMediaBytes, setBackupBytes } = await import("@/lib/uploads/storage-gauge");
const { resetServerEnv } = await import("@/lib/env");
const { r2StorageGauge } = await import("@/worker/jobs/r2-storage-gauge");

const NOW = new Date("2026-10-16T03:10:00Z");

beforeEach(() => {
  configured.value = true;
  delete process.env.R2_STORAGE_BASELINE_BYTES;
  resetServerEnv();
  vi.mocked(sumStoredBytes).mockClear();
  vi.mocked(resetMediaBytes).mockClear();
  vi.mocked(setBackupBytes).mockClear();
  vi.mocked(readRetainedBackupBytes).mockClear();
});

afterEach(() => {
  delete process.env.R2_STORAGE_BASELINE_BYTES;
  resetServerEnv();
});

describe("r2-storage-gauge", () => {
  it("recounts the stored photos and the retained backups, replaces both counters and reports the account total", async () => {
    expect(await r2StorageGauge(NOW)).toEqual({
      mediaBytes: 2_500_000_000,
      backupBytes: 300_000_000,
      reserveBytes: 64_000_000,
      baselineBytes: 4_140_000_000,
      totalBytes: 2_500_000_000 + 300_000_000 + 64_000_000 + 4_140_000_000,
      counterBefore: 2_400_000_000,
      level: "ok",
    });
    expect(sumStoredBytes).toHaveBeenCalledTimes(1);
    expect(readRetainedBackupBytes).toHaveBeenCalledWith({ fake: "db" }, NOW);
    expect(setBackupBytes).toHaveBeenCalledWith(300_000_000, NOW);
    expect(resetMediaBytes).toHaveBeenCalledWith(2_500_000_000, NOW);
    // The backup counter is in place before the media recount refreshes the gauge.
    expect(vi.mocked(setBackupBytes).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(resetMediaBytes).mock.invocationCallOrder[0]!);
  });

  it("keeps the last recorded backup bytes when system/backup cannot be read", async () => {
    vi.mocked(readRetainedBackupBytes).mockRejectedValueOnce(new Error("UNAVAILABLE"));
    const result = await r2StorageGauge(NOW);
    expect(result).toMatchObject({ backupBytes: 250_000_000, totalBytes: 2_500_000_000 + 250_000_000 + 64_000_000 + 4_140_000_000 });
    expect(setBackupBytes).not.toHaveBeenCalled();
  });

  it("uses the configured baseline and reports an unknown level without Valkey", async () => {
    process.env.R2_STORAGE_BASELINE_BYTES = "1000";
    resetServerEnv();
    vi.mocked(resetMediaBytes).mockResolvedValueOnce(null);
    vi.mocked(readMediaBytes).mockResolvedValueOnce(null);
    expect(await r2StorageGauge(NOW)).toMatchObject({ mediaBytes: 2_500_000_000, baselineBytes: 1000, totalBytes: 2_500_000_000 + 300_000_000 + 64_000_000 + 1000, counterBefore: null, level: "unknown" });
  });

  it("skips without Firebase", async () => {
    configured.value = false;
    expect(await r2StorageGauge(NOW)).toBeNull();
    expect(sumStoredBytes).not.toHaveBeenCalled();
  });
});
