import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// audit-export (design D23, 03:22 UTC): which UTC days a run exports (cursor, catch-up bounded to
// AUDIT_EXPORT_MAX_DAYS), and the runs that must write nothing (no or bad recipient, no storage,
// read quota degraded). The export itself (NDJSON -> gzip -> age, decrypted back) runs against
// the emulator in tests/api/jobs-phase5/audit-export.test.ts.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async () => false) }));
const firebase = { configured: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => firebase.configured, isFirebaseConfigured: () => firebase.configured, db: vi.fn() }));
const storage = { store: null as unknown, missing: false };
class FakeStorageNotConfigured extends Error {}
vi.mock("@/lib/storage", () => ({
  objectStore: () => {
    if (storage.missing) throw new FakeStorageNotConfigured("not configured");
    return storage.store;
  },
  isStorageNotConfigured: (error: unknown) => error instanceof FakeStorageNotConfigured,
}));

const { alert } = await import("@/lib/alert");
const { isDegraded } = await import("@/lib/quota");
const { generateIdentity, identityToRecipient } = await import("@/lib/backup/crypto");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { resetServerEnv } = await import("@/lib/env");
const { AUDIT_EXPORT_MAX_DAYS, auditExportKey, exportAuditLogs, exportDays } = await import("@/worker/jobs/audit-export");

const NOW = new Date("2026-10-16T03:22:00Z");
let recipient: string;

/** A Firestore that must not be touched. */
const untouchable = new Proxy(
  {},
  {
    get: (_, name) => {
      throw new Error(`Firestore accessed (${String(name)})`);
    },
  },
) as never;

beforeAll(async () => {
  recipient = await identityToRecipient(await generateIdentity());
});

beforeEach(() => {
  vi.mocked(alert).mockClear();
  vi.mocked(isDegraded).mockReset().mockResolvedValue(false);
  firebase.configured = true;
  storage.missing = false;
  storage.store = new MemoryObjectStore();
});

afterEach(() => {
  delete process.env.BACKUP_AGE_RECIPIENT;
  resetServerEnv();
});

describe("exportDays", () => {
  it("yesterday (UTC) without a cursor, nothing when yesterday is done", () => {
    expect(exportDays(NOW, null)).toEqual(["2026-10-15"]);
    expect(exportDays(new Date("2026-10-16T00:00:00Z"), null)).toEqual(["2026-10-15"]);
    expect(exportDays(new Date("2026-10-16T23:59:59Z"), null)).toEqual(["2026-10-15"]);
    expect(exportDays(NOW, "2026-10-15")).toEqual([]);
    expect(exportDays(NOW, "2026-10-16")).toEqual([]);
    expect(exportDays(NOW, "garbage")).toEqual(["2026-10-15"]);
  });

  it("catches missed nights up, oldest first, AUDIT_EXPORT_MAX_DAYS a run", () => {
    expect(exportDays(NOW, "2026-10-13")).toEqual(["2026-10-14", "2026-10-15"]);
    const days = exportDays(NOW, "2026-09-30");
    expect(days).toHaveLength(AUDIT_EXPORT_MAX_DAYS);
    expect(days[0]).toBe("2026-10-01");
    expect(days.at(-1)).toBe("2026-10-07");
    // Across a month end.
    expect(exportDays(new Date("2026-11-01T03:22:00Z"), "2026-10-30")).toEqual(["2026-10-31"]);
  });

  it("names the object audit/{date}.ndjson.gz.age", () => {
    expect(auditExportKey("2026-10-15")).toBe("audit/2026-10-15.ndjson.gz.age");
  });
});

describe("exportAuditLogs without a usable key or storage", () => {
  it("writes nothing, reads nothing and alerts (P1) without a valid recipient", async () => {
    const store = new MemoryObjectStore();
    for (const value of [undefined, "", "age1short", recipient.slice(0, -1) + (recipient.endsWith("q") ? "p" : "q")]) {
      const result = await exportAuditLogs(NOW, { db: untouchable, store, recipient: value });
      expect(result).toEqual({ status: "skipped", reason: "no_recipient", days: [] });
    }
    expect(store.calls).toEqual([]);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ severity: "P1", title: "Export du journal d'audit non effectué" });
  });

  it("reads BACKUP_AGE_RECIPIENT from the environment", async () => {
    process.env.BACKUP_AGE_RECIPIENT = "age1notvalid";
    resetServerEnv();
    expect(await exportAuditLogs(NOW, { db: untouchable, store: new MemoryObjectStore() })).toMatchObject({ reason: "no_recipient" });
  });

  it("writes nothing without object storage", async () => {
    storage.missing = true;
    expect(await exportAuditLogs(NOW, { db: untouchable, recipient })).toEqual({ status: "skipped", reason: "no_storage", days: [] });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1" }));
  });

  it("waits while the Firestore read quota is degraded, and without Firebase", async () => {
    vi.mocked(isDegraded).mockResolvedValue(true);
    const store = new MemoryObjectStore();
    expect(await exportAuditLogs(NOW, { db: untouchable, store, recipient })).toEqual({ status: "skipped", reason: "quota", days: [] });
    firebase.configured = false;
    expect(await exportAuditLogs(NOW, { store, recipient })).toEqual({ status: "skipped", reason: "not_configured", days: [] });
    expect(store.calls).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });
});
