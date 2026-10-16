import { beforeEach, describe, expect, it, vi } from "vitest";

// backup-firestore hands the bytes of the backups still in the private bucket (98 days) to the R2
// storage gauge after a completed run; a skipped or failed run leaves the counter alone.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => true, isFirebaseConfigured: () => true, db: vi.fn(() => ({})) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ setBackupBytes: vi.fn(async () => null) }));
vi.mock("@/lib/backup/export", async (importOriginal) => ({
  ...(await importOriginal<typeof Export>()),
  runBackup: vi.fn(),
}));

import type * as Export from "@/lib/backup/export";

const { runBackup, skippedBackup } = await import("@/lib/backup/export");
const { setBackupBytes } = await import("@/lib/uploads/storage-gauge");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { backupFirestore } = await import("@/worker/jobs/backup-firestore");

const NOW = new Date("2026-10-16T03:30:00Z");
const deps = () => ({ db: {} as never, store: new MemoryObjectStore(), recipient: "age1fake" });

beforeEach(() => {
  vi.mocked(runBackup).mockReset();
  vi.mocked(setBackupBytes).mockClear();
});

describe("backup-firestore and the R2 storage gauge", () => {
  it("records the retained backup bytes after a completed run", async () => {
    vi.mocked(runBackup).mockResolvedValue({ ...skippedBackup("already_done", "2026-10-16"), status: "done", reason: undefined, bytes: 4_000, retainedBytes: 123_456 });
    expect(await backupFirestore(NOW, deps())).toMatchObject({ status: "done", retainedBytes: 123_456 });
    expect(setBackupBytes).toHaveBeenCalledWith(123_456, NOW);
  });

  it("leaves the counter alone when the run was skipped or failed", async () => {
    vi.mocked(runBackup).mockResolvedValueOnce(skippedBackup("reads_degraded", "2026-10-16"));
    expect(await backupFirestore(NOW, deps())).toMatchObject({ status: "skipped", retainedBytes: null });
    vi.mocked(runBackup).mockRejectedValueOnce(new Error("R2 503"));
    await expect(backupFirestore(NOW, deps())).rejects.toThrow("R2 503");
    expect(setBackupBytes).not.toHaveBeenCalled();
  });
});
