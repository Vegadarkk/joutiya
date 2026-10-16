import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// backup-firestore (03:30 UTC, D17): the runs that must write nothing (no or bad recipient, read
// quota degraded, already done today, no storage) and the failure alert. Full runs are in
// tests/api/backup/restore.test.ts (emulator).

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
const valkeyState = { configured: false };
const set = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => "OK");
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => valkeyState.configured, valkey: () => ({ set }) }));
vi.mock("@/lib/quota", () => ({
  consume: vi.fn(async () => ({ id: "firestore.reads", period: "p", used: 0, limit: 50_000, ratio: 0, level: "unknown" })),
  isDegraded: vi.fn(async () => false),
}));
const firebase = { configured: true, db: vi.fn() };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => firebase.configured, isFirebaseConfigured: () => firebase.configured, db: () => firebase.db() }));
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
const { manifestKey } = await import("@/lib/backup/parts");
const { resetBackupAlertMemory, runBackup } = await import("@/lib/backup/export");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { resetServerEnv } = await import("@/lib/env");
const { backupFirestore } = await import("@/worker/jobs/backup-firestore");

const NOW = new Date("2026-10-16T03:30:00Z");
let recipient: string;

/** A Firestore that must not be touched. */
const untouchable = new Proxy({}, { get: (_, name) => { throw new Error(`Firestore accessed (${String(name)})`); } }) as never;

function cursorDb(data: Record<string, unknown> | undefined) {
  const get = vi.fn(async () => ({ data: () => data }));
  const set = vi.fn(async () => undefined);
  const doc = { get, set };
  return { db: { collection: () => ({ doc: () => doc }) } as never, doc };
}

beforeAll(async () => {
  recipient = await identityToRecipient(await generateIdentity());
});

beforeEach(() => {
  resetBackupAlertMemory();
  vi.mocked(alert).mockClear();
  vi.mocked(isDegraded).mockResolvedValue(false);
  valkeyState.configured = false;
  set.mockReset();
  set.mockResolvedValue("OK");
  firebase.configured = true;
  storage.missing = false;
  storage.store = new MemoryObjectStore();
});

afterEach(() => {
  delete process.env.BACKUP_AGE_RECIPIENT;
  resetServerEnv();
});

describe("runBackup without a usable recipient", () => {
  it("writes nothing, reads nothing and alerts once a day", async () => {
    const store = new MemoryObjectStore();
    for (const value of [undefined, "", "age1short"]) {
      const result = await runBackup({ db: untouchable, store, recipient: value, now: NOW });
      expect(result).toMatchObject({ status: "skipped", reason: "no_recipient", parts: 0, manifestKey: null });
    }
    expect(store.calls).toEqual([]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ severity: "P1", title: expect.stringContaining("clé de chiffrement absente") });
    await runBackup({ db: untouchable, store, recipient: undefined, now: new Date("2026-10-17T03:30:00Z") });
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("treats a recipient with a bad checksum as missing", async () => {
    const last = recipient.slice(-1);
    const broken = recipient.slice(0, -1) + (last === "q" ? "p" : "q");
    const store = new MemoryObjectStore();
    expect(await runBackup({ db: untouchable, store, recipient: broken, now: NOW })).toMatchObject({ status: "skipped", reason: "no_recipient" });
    expect(store.calls).toEqual([]);
  });

  it("dedupes the alert through valkey-queue across processes", async () => {
    valkeyState.configured = true;
    set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    await runBackup({ db: untouchable, store: new MemoryObjectStore(), recipient: undefined, now: NOW });
    await runBackup({ db: untouchable, store: new MemoryObjectStore(), recipient: undefined, now: NOW });
    expect(set).toHaveBeenCalledWith("backup:alerted:no_recipient:2026-10-16", "1", "EX", 172_800, "NX");
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe("runBackup that must not run", () => {
  it("defers while the Firestore read quota is degraded", async () => {
    vi.mocked(isDegraded).mockResolvedValue(true);
    const store = new MemoryObjectStore();
    expect(await runBackup({ db: untouchable, store, recipient, now: NOW })).toMatchObject({ status: "skipped", reason: "reads_degraded" });
    expect(store.calls).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it("runs once per UTC date: after a completed run, or when a manifest already exists", async () => {
    const done = cursorDb({ lastDate: "2026-10-16" });
    const store = new MemoryObjectStore();
    expect(await runBackup({ db: done.db, store, recipient, now: NOW })).toMatchObject({ status: "skipped", reason: "already_done" });
    expect(done.doc.set).not.toHaveBeenCalled();
    expect(store.calls.filter((call) => call.op === "put")).toEqual([]);

    const failedAfterManifest = cursorDb({ lastDate: "2026-10-15" });
    store.seed("private", manifestKey("2026-10-16"), new Uint8Array([1]), { contentType: "application/octet-stream" });
    expect(await runBackup({ db: failedAfterManifest.db, store, recipient, now: NOW })).toMatchObject({ status: "skipped", reason: "already_done" });
    expect(failedAfterManifest.doc.set).not.toHaveBeenCalled();
    expect(store.calls.filter((call) => call.op === "put")).toEqual([]);
  });
});

describe("backup-firestore job", () => {
  it("skips without Firebase", async () => {
    firebase.configured = false;
    expect(await backupFirestore(NOW)).toBeNull();
    expect(firebase.db).not.toHaveBeenCalled();
  });

  it("alerts once a day and writes nothing without object storage", async () => {
    storage.missing = true;
    expect(await backupFirestore(NOW)).toMatchObject({ status: "skipped", reason: "no_storage" });
    expect(await backupFirestore(NOW)).toMatchObject({ status: "skipped", reason: "no_storage" });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ title: expect.stringContaining("stockage R2 non configuré") });
  });

  it("reads the recipient from BACKUP_AGE_RECIPIENT", async () => {
    firebase.db.mockReturnValue(untouchable);
    expect(await backupFirestore(NOW)).toMatchObject({ status: "skipped", reason: "no_recipient" });
    process.env.BACKUP_AGE_RECIPIENT = recipient;
    resetServerEnv();
    const done = cursorDb({ lastDate: "2026-10-16" });
    firebase.db.mockReturnValue(done.db);
    expect(await backupFirestore(NOW)).toMatchObject({ status: "skipped", reason: "already_done" });
  });

  it("alerts on a failure and rethrows it (one attempt, the cursors stay)", async () => {
    const broken = { collection: () => ({ doc: () => ({ get: async () => Promise.reject(new Error("deadline exceeded")) }) }) } as never;
    await expect(backupFirestore(NOW, { db: broken, store: new MemoryObjectStore(), recipient })).rejects.toThrow("deadline exceeded");
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: "Sauvegarde Firestore en échec", body: expect.stringContaining("deadline exceeded") }));
  });
});
