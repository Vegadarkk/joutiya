import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/db/repositories/users", () => ({ listPendingAccounts: vi.fn(), deleteAccountDocumentsIfPending: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async () => false) }));
vi.mock("@/lib/auth/activation", () => ({ activateMember: vi.fn(async () => true) }));

type AuthRecord = { emailVerified: boolean; customClaims?: Record<string, unknown> };
const deleteUser = vi.fn<(uid: string) => Promise<void>>(async () => undefined);
const getUser = vi.fn<(uid: string) => Promise<AuthRecord>>(async () => ({ emailVerified: false }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ auth: () => ({ deleteUser, getUser }), isFirebaseConfigured: () => configured.value }));

const { listPendingAccounts, deleteAccountDocumentsIfPending } = await import("@/lib/db/repositories/users");
const { consume, isDegraded } = await import("@/lib/quota");
const { activateMember } = await import("@/lib/auth/activation");
const { purgeUnactivated, resetPurgeMemory, PURGE_AFTER_MS, PURGE_BATCH } = await import("@/worker/jobs/purge-unactivated");
const { JOBS, SCHEDULES } = await import("@/worker/jobs");

class AuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const NONE = { purged: 0, activated: 0, failed: 0, skipped: 0 };

beforeEach(() => {
  configured.value = true;
  resetPurgeMemory();
  deleteUser.mockReset();
  deleteUser.mockResolvedValue(undefined);
  getUser.mockReset();
  getUser.mockResolvedValue({ emailVerified: false });
  vi.mocked(deleteAccountDocumentsIfPending).mockReset();
  vi.mocked(deleteAccountDocumentsIfPending).mockResolvedValue(true);
  vi.mocked(listPendingAccounts).mockReset();
  vi.mocked(activateMember).mockReset();
  vi.mocked(activateMember).mockResolvedValue(true);
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(consume).mockClear();
});

describe("purge-unactivated", () => {
  it("deletes the documents then the Auth record of every account pending for 24 h", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-a", "uid-b"]);
    const now = new Date("2026-10-16T12:05:00Z");
    expect(await purgeUnactivated(now)).toEqual({ ...NONE, purged: 2 });
    expect(listPendingAccounts).toHaveBeenCalledWith(new Date(now.getTime() - PURGE_AFTER_MS), PURGE_BATCH);
    expect(PURGE_AFTER_MS).toBe(24 * 3_600_000);
    expect(getUser.mock.calls.map(([uid]) => uid)).toEqual(["uid-a", "uid-b"]);
    expect(deleteUser.mock.calls.map(([uid]) => uid)).toEqual(["uid-a", "uid-b"]);
    expect(vi.mocked(deleteAccountDocumentsIfPending).mock.calls.map(([uid]) => uid)).toEqual(["uid-a", "uid-b"]);
    // Documents first, Auth record last (B4).
    expect(vi.mocked(deleteAccountDocumentsIfPending).mock.invocationCallOrder[0]).toBeLessThan(deleteUser.mock.invocationCallOrder[0] ?? 0);
    expect(activateMember).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith("firestore.deletes", 6);
  });

  it("activates instead of purging an account whose e-mail was verified in the meantime", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-verified", "uid-pending"]);
    getUser.mockImplementation(async (uid) => (uid === "uid-verified" ? { emailVerified: true, customClaims: { v: 2 } } : { emailVerified: false }));
    expect(await purgeUnactivated()).toEqual({ ...NONE, purged: 1, activated: 1 });
    expect(activateMember).toHaveBeenCalledWith("uid-verified", { v: 2 });
    expect(deleteAccountDocumentsIfPending).not.toHaveBeenCalledWith("uid-verified");
    expect(deleteUser).not.toHaveBeenCalledWith("uid-verified");
    expect(deleteAccountDocumentsIfPending).toHaveBeenCalledWith("uid-pending");
    expect(consume).toHaveBeenCalledWith("firestore.deletes", 3);
  });

  it("counts a verified account that cannot be activated as failed, untouched", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-staff"]);
    getUser.mockResolvedValue({ emailVerified: true, customClaims: { role: "admin", v: 2 } });
    vi.mocked(activateMember).mockResolvedValue(false);
    expect(await purgeUnactivated()).toEqual({ ...NONE, failed: 1 });
    expect(deleteAccountDocumentsIfPending).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("keeps an account activated between the listing and the purge", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-late", "uid-pending"]);
    vi.mocked(deleteAccountDocumentsIfPending).mockImplementation(async (uid) => uid !== "uid-late");
    expect(await purgeUnactivated()).toEqual({ ...NONE, purged: 1 });
    expect(deleteUser).not.toHaveBeenCalledWith("uid-late");
    expect(deleteUser).toHaveBeenCalledWith("uid-pending");
  });

  it("tolerates a missing Auth user and still removes the documents", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-gone", "uid-racing"]);
    getUser.mockImplementation(async (uid) => {
      if (uid === "uid-gone") throw new AuthError("auth/user-not-found");
      return { emailVerified: false };
    });
    // Deleted between getUser and deleteUser.
    deleteUser.mockImplementation(async (uid) => {
      if (uid === "uid-racing") throw new AuthError("auth/user-not-found");
    });
    expect(await purgeUnactivated()).toEqual({ ...NONE, purged: 2 });
    expect(deleteAccountDocumentsIfPending).toHaveBeenCalledWith("uid-gone");
    expect(deleteUser).not.toHaveBeenCalledWith("uid-gone");
    expect(deleteUser).toHaveBeenCalledWith("uid-racing");
  });

  it("counts other failures without stopping the batch and skips them on the next run only", async () => {
    vi.mocked(listPendingAccounts).mockResolvedValue(["uid-1", "uid-2", "uid-3"]);
    getUser.mockImplementation(async (uid) => {
      if (uid === "uid-1") throw new AuthError("auth/internal-error");
      return { emailVerified: false };
    });
    vi.mocked(deleteAccountDocumentsIfPending).mockImplementation(async (uid) => {
      if (uid === "uid-3") throw new Error("firestore unavailable");
      return true;
    });
    expect(await purgeUnactivated()).toEqual({ ...NONE, purged: 1, failed: 2 });
    expect(deleteAccountDocumentsIfPending).not.toHaveBeenCalledWith("uid-1");
    expect(deleteUser).not.toHaveBeenCalledWith("uid-3");
    expect(consume).toHaveBeenCalledWith("firestore.deletes", 3);

    // Next run: the two failed uids are skipped so the batch never starves on them.
    getUser.mockClear();
    expect(await purgeUnactivated()).toEqual({ ...NONE, purged: 1, skipped: 2 });
    expect(getUser.mock.calls.map(([uid]) => uid)).toEqual(["uid-2"]);

    // The run after: they are tried again.
    getUser.mockClear();
    expect(await purgeUnactivated()).toEqual({ ...NONE, purged: 1, failed: 2 });
    expect(getUser.mock.calls.map(([uid]) => uid)).toEqual(["uid-1", "uid-2", "uid-3"]);
  });

  it("does nothing without Firebase or when the delete quota is degraded", async () => {
    configured.value = false;
    expect(await purgeUnactivated()).toEqual(NONE);
    configured.value = true;
    vi.mocked(isDegraded).mockResolvedValue(true);
    expect(await purgeUnactivated()).toEqual(NONE);
    expect(listPendingAccounts).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("is registered as an hourly job of the system queue", () => {
    expect(JOBS["purge-unactivated"]).toBeTypeOf("function");
    expect(SCHEDULES["purge-unactivated-hourly"]).toEqual({ pattern: "5 * * * *", job: "purge-unactivated" });
    expect(SCHEDULES["quota-report-nightly"]).toEqual({ pattern: "15 8 * * *", job: "quota-report" });
  });
});
