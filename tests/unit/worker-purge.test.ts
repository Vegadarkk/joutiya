import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/db/repositories/users", () => ({ listPendingAccounts: vi.fn(), deleteAccountDocuments: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async () => false) }));

const deleteUser = vi.fn<(uid: string) => Promise<void>>(async () => undefined);
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ auth: () => ({ deleteUser }), isFirebaseConfigured: () => configured.value }));

const { listPendingAccounts, deleteAccountDocuments } = await import("@/lib/db/repositories/users");
const { consume, isDegraded } = await import("@/lib/quota");
const { purgeUnactivated, PURGE_AFTER_MS, PURGE_BATCH } = await import("@/worker/jobs/purge-unactivated");
const { JOBS, SCHEDULES } = await import("@/worker/jobs");

class AuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

beforeEach(() => {
  configured.value = true;
  deleteUser.mockReset();
  deleteUser.mockResolvedValue(undefined);
  vi.mocked(deleteAccountDocuments).mockReset();
  vi.mocked(deleteAccountDocuments).mockResolvedValue(undefined);
  vi.mocked(listPendingAccounts).mockReset();
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(consume).mockClear();
});

describe("purge-unactivated", () => {
  it("deletes the Auth record then the documents of every account pending for 24 h", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-a", "uid-b"]);
    const now = new Date("2026-10-16T12:05:00Z");
    expect(await purgeUnactivated(now)).toEqual({ purged: 2, failed: 0 });
    expect(listPendingAccounts).toHaveBeenCalledWith(new Date(now.getTime() - PURGE_AFTER_MS), PURGE_BATCH);
    expect(PURGE_AFTER_MS).toBe(24 * 3_600_000);
    expect(deleteUser.mock.calls.map(([uid]) => uid)).toEqual(["uid-a", "uid-b"]);
    expect(vi.mocked(deleteAccountDocuments).mock.calls.map(([uid]) => uid)).toEqual(["uid-a", "uid-b"]);
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deleteAccountDocuments).mock.invocationCallOrder[0] ?? 0);
    expect(consume).toHaveBeenCalledWith("firestore.deletes", 6);
  });

  it("tolerates a missing Auth user and still removes the documents", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-gone"]);
    deleteUser.mockRejectedValue(new AuthError("auth/user-not-found"));
    expect(await purgeUnactivated()).toEqual({ purged: 1, failed: 0 });
    expect(deleteAccountDocuments).toHaveBeenCalledWith("uid-gone");
  });

  it("counts other failures without stopping the batch", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-1", "uid-2", "uid-3"]);
    deleteUser.mockImplementation(async (uid) => {
      if (uid === "uid-1") throw new AuthError("auth/internal-error");
    });
    vi.mocked(deleteAccountDocuments).mockImplementation(async (uid) => {
      if (uid === "uid-3") throw new Error("firestore unavailable");
    });
    expect(await purgeUnactivated()).toEqual({ purged: 1, failed: 2 });
    expect(deleteAccountDocuments).not.toHaveBeenCalledWith("uid-1");
    expect(consume).toHaveBeenCalledWith("firestore.deletes", 3);
  });

  it("does nothing without Firebase or when the delete quota is degraded", async () => {
    configured.value = false;
    expect(await purgeUnactivated()).toEqual({ purged: 0, failed: 0 });
    configured.value = true;
    vi.mocked(isDegraded).mockResolvedValue(true);
    expect(await purgeUnactivated()).toEqual({ purged: 0, failed: 0 });
    expect(listPendingAccounts).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("is registered as an hourly job of the system queue", () => {
    expect(JOBS["purge-unactivated"]).toBeTypeOf("function");
    expect(SCHEDULES["purge-unactivated-hourly"]).toEqual({ pattern: "5 * * * *", job: "purge-unactivated" });
    expect(SCHEDULES["quota-report-nightly"]).toEqual({ pattern: "15 8 * * *", job: "quota-report" });
  });
});
