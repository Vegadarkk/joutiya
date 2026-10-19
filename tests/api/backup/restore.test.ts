import { DocumentReference, Firestore, GeoPoint, Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Backups end to end against the Firestore emulator (D17, phase 3 exit test "restore tested"):
// seeded documents -> runBackup into a MemoryObjectStore (encrypted with an in-memory key pair)
// -> restore -> identical documents (Timestamps, GeoPoints, bytes, references, nested maps,
// arrays). Plus the cursor semantics across nights: equal timestamps under a budget, round robin,
// rolling full cycle, failed upload, read quota stop. Each test works in its own named database,
// so other test files' data never mixes in.

const quota = { ratio: 0, level: "unknown" as string };
vi.mock("@/lib/quota", () => ({
  consume: vi.fn(async (id: string) => ({ id, period: "p", used: 0, limit: 50_000, ratio: quota.ratio, level: quota.level })),
  isDegraded: vi.fn(async () => false),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

const { alert } = await import("@/lib/alert");
const { BACKUP_RETENTION_DAYS, readRetainedBackupBytes, runBackup } = await import("@/lib/backup/export");
const { generateIdentity, identityToRecipient } = await import("@/lib/backup/crypto");
const { applyRestore, checkRestore, planRestore } = await import("@/lib/backup/restore");
const { MemoryObjectStore } = await import("@/lib/storage/memory");

type Store = InstanceType<typeof MemoryObjectStore>;
type BackupConfig = NonNullable<Parameters<typeof runBackup>[0]["config"]>;

const run = Date.now().toString(36);
let counter = 0;
let identity: string;
let recipient: string;

function database(): Firestore {
  counter += 1;
  return new Firestore({ projectId: process.env.FIREBASE_PROJECT_ID, databaseId: `bk-${run}-${counter}`, ignoreUndefinedProperties: true });
}

const storeSource = (store: Store) => ({
  label: "memory",
  list: async () => store.keys("private"),
  read: async (key: string) => {
    const body = await store.get("private", key);
    if (!body) throw new Error(`missing ${key}`);
    return body;
  },
});

/** Independent of src/lib/backup/encode.ts, so an encoding bug cannot cancel itself out. */
function normalize(value: unknown): unknown {
  if (value instanceof Timestamp) return { ts: [value.seconds, value.nanoseconds] };
  if (value instanceof GeoPoint) return { geo: [value.latitude, value.longitude] };
  if (value instanceof DocumentReference) return { ref: value.path };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}

const BACKED_UP = ["users", "emailIndex", "listings", "auditLogs", "connectionLogs", "staff", "uploads", "moderationDecisions"] as const;

async function dump(db: Firestore): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const snapshots = [...(await Promise.all(BACKED_UP.map((id) => db.collection(id).get()))), await db.collectionGroup("private").get()];
  for (const snapshot of snapshots) for (const doc of snapshot.docs) out[doc.ref.path] = normalize(doc.data());
  return out;
}

async function deleteAll(db: Firestore, paths: string[]): Promise<void> {
  const batch = db.batch();
  for (const path of paths) batch.delete(db.doc(path));
  await batch.commit();
}

const ago = (now: Date, ms: number) => Timestamp.fromDate(new Date(now.getTime() - ms));

async function seed(db: Firestore, now: Date): Promise<void> {
  const batch = db.batch();
  batch.set(db.doc("users/u1"), {
    displayName: "Amina Berrada",
    publicId: "p-u1",
    createdAt: new Timestamp(1_790_000_000, 123_456_000),
    updatedAt: ago(now, 3_600_000),
    location: new GeoPoint(33.5731, -7.5898),
    avatarHash: Buffer.from([0, 1, 2, 250, 255]),
    favorite: db.doc("listings/l1"),
    prefs: { nested: { deep: [1, "deux", { trois: true, at: new Timestamp(1_790_000_100, 0) }] }, empty: {} },
    tags: ["a", "b"],
    emptyList: [],
    none: null,
    active: false,
    rating: 4.5,
    count: 3,
    __t: "user field named like the tag",
    spoof: { __t: "ref", path: "users/u2" },
    arabic: "دراجة هوائية",
  });
  batch.set(db.doc("users/u1/private/account"), { phone: "+212612345678", consents: { cgu: "2026-10", marketing: false }, verifiedAt: ago(now, 7_200_000) });
  batch.set(db.doc("users/u2"), { displayName: "Youssef", updatedAt: ago(now, 1_800_000), createdAt: ago(now, 86_400_000 * 30) });
  batch.set(db.doc("users/u2/private/account"), { phone: null, refs: [db.doc("users/u1"), db.doc("listings/l2")] });
  for (const [id, updatedAt] of [
    ["l1", ago(now, 600_000 + 5_000)],
    ["l2", ago(now, 900_000)],
    ["l3", ago(now, 900_000)],
  ] as const) {
    batch.set(db.doc(`listings/${id}`), { title: `Annonce ${id}`, price: 1_500, updatedAt, geo: new GeoPoint(34.02, -6.84), photos: [{ id: "p1", w: 1600, h: 1200 }] });
  }
  for (const id of ["a1", "a2", "a3"]) batch.set(db.doc(`auditLogs/${id}`), { action: "listing.publish", at: ago(now, 3_000_000) });
  batch.set(db.doc("emailIndex/hash1"), { uid: "u1", createdAt: ago(now, 3_000_000) });
  // Not in the backup table: never touched by a restore.
  batch.set(db.doc("quotaDaily/2026-10-15"), { reads: 1 });
  await batch.commit();
}

async function restore(store: Store, target: Firestore, options: Parameters<typeof planRestore>[2] = {}) {
  const source = storeSource(store);
  const plan = await planRestore(source, identity, options);
  const check = await checkRestore(source, plan, identity);
  const result = await applyRestore(source, plan, check, identity, target);
  return { plan, check, result };
}

beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

beforeEach(() => {
  quota.ratio = 0;
  quota.level = "unknown";
  vi.mocked(alert).mockClear();
});

describe("backup and restore round trip", () => {
  it("backs up every collection encrypted and restores it identically into an empty database", async () => {
    const source = database();
    const now = new Date();
    await seed(source, now);
    const store = new MemoryObjectStore();
    const result = await runBackup({ db: source, store, recipient, now });
    expect(result).toMatchObject({ status: "done", truncated: false, quotaStopped: false });
    expect(result.counts.full).toMatchObject({ users: 2, private: 2, listings: 3, auditLogs: 3, emailIndex: 1, staff: 0, uploads: 0 });
    expect(result.counts.incremental).toEqual({ users: 2, emailIndex: 1, staff: 0, listings: 3, uploads: 0, moderationDecisions: 0, favorites: 0, savedSearches: 0 });
    const date = now.toISOString().slice(0, 10);
    expect(store.keys("private")).toContain(`backups/${date}/manifest.json.age`);
    expect(store.keys("private")).toContain(`backups/${date}/full/private.ndjson.gz.age`);
    for (const key of store.keys("private")) {
      expect(key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}\/((incremental|full)\/[A-Za-z]+\.ndjson\.gz\.age|manifest\.json\.age)$/);
      const body = (await store.get("private", key)) as Buffer;
      for (const plain of ["Amina", "+212612345678", "listings/l1", "displayName"]) expect(body.includes(Buffer.from(plain)), `${key} holds plaintext`).toBe(false);
    }

    const target = database();
    const restored = await restore(store, target);
    expect(restored.plan.verifiedDates).toEqual([date]);
    expect(restored.plan.warnings).toEqual([]);
    expect(restored.result.writes).toBe(11);
    expect(restored.check.documents).toBe(11);
    expect(await dump(target)).toEqual(await dump(source));
    const favorite = (await target.doc("users/u1").get()).get("favorite") as DocumentReference;
    expect(favorite.firestore).toBe(target);
    expect((await target.doc("quotaDaily/2026-10-15").get()).exists).toBe(false);
  });

  it("restores in place after the documents were deleted", async () => {
    const db = database();
    const now = new Date();
    await seed(db, now);
    const store = new MemoryObjectStore();
    await runBackup({ db, store, recipient, now });
    const before = await dump(db);
    await deleteAll(db, Object.keys(before));
    expect(await dump(db)).toEqual({});
    await restore(store, db);
    expect(await dump(db)).toEqual(before);
    expect((await db.doc("quotaDaily/2026-10-15").get()).data()).toEqual({ reads: 1 });
  });

  it("restores the latest state after changes between nights (and resurrects deleted documents)", async () => {
    const db = database();
    const day1 = new Date();
    await seed(db, day1);
    const store = new MemoryObjectStore();
    await runBackup({ db, store, recipient, now: day1 });
    await db.doc("users/u1").update({ displayName: "Amina B.", updatedAt: Timestamp.now() });
    await db.doc("users/u1/private/account").update({ phone: "+212700000000" });
    await db.doc("listings/l3").delete();
    const day2 = new Date(day1.getTime() + 86_400_000);
    expect(await runBackup({ db, store, recipient, now: day2 })).toMatchObject({ status: "done" });
    // One run per date.
    expect(await runBackup({ db, store, recipient, now: day2 })).toMatchObject({ status: "skipped", reason: "already_done" });

    const target = database();
    const { plan } = await restore(store, target);
    expect(plan.dates).toHaveLength(2);
    const restored = await dump(target);
    expect((restored["users/u1"] as Record<string, unknown>)["displayName"]).toBe("Amina B.");
    expect((restored["users/u1/private/account"] as Record<string, unknown>)["phone"]).toBe("+212700000000");
    expect(restored["listings/l3"]).toBeDefined();
    // The state as of the first night.
    const asOfDay1 = database();
    await restore(store, asOfDay1, { until: day1.toISOString().slice(0, 10) });
    expect(((await dump(asOfDay1))["users/u1"] as Record<string, unknown>)["displayName"]).toBe("Amina Berrada");
  });
});

describe("cursors across nights", () => {
  const listingsAndUsers: BackupConfig["collections"] = [
    { id: "listings", scope: "root", timeField: "updatedAt" },
    { id: "users", scope: "root", timeField: "updatedAt" },
  ];

  it("exports every document exactly once when a budget cuts through equal timestamps", async () => {
    const db = database();
    const start = new Date("2026-10-10T03:30:00Z");
    const same = ago(start, 3_600_000);
    const batch = db.batch();
    for (let index = 0; index < 7; index += 1) batch.set(db.doc(`listings/s${index}`), { updatedAt: same });
    batch.set(db.doc("listings/later1"), { updatedAt: ago(start, 3_599_000) });
    batch.set(db.doc("listings/later2"), { updatedAt: ago(start, 3_599_000) });
    for (let index = 0; index < 3; index += 1) batch.set(db.doc(`users/u${index}`), { updatedAt: same });
    await batch.commit();

    const store = new MemoryObjectStore();
    const config: Partial<BackupConfig> = { collections: listingsAndUsers, incrementalMax: 3, pageSize: 2, fullBudget: 0 };
    const first = await runBackup({ db, store, recipient, now: start, config });
    expect(first).toMatchObject({ status: "done", truncated: true });
    expect(first.counts.incremental).toEqual({ listings: 3 });
    const cursor = (await db.doc("system/backup").get()).data() as Record<string, unknown>;
    expect(cursor["incrementalNext"]).toBe("listings");
    const listings = (cursor["incremental"] as Record<string, { since: Timestamp; after: string }>)["listings"];
    expect(listings?.since.isEqual(same)).toBe(true);
    expect(listings?.after).toBe("listings/s2");

    let runs = 1;
    let last = first;
    while (last.truncated && runs < 10) {
      last = await runBackup({ db, store, recipient, now: new Date(start.getTime() + runs * 86_400_000), config });
      runs += 1;
    }
    expect(last.truncated).toBe(false);
    const { check } = await restore(store, database());
    expect([...check.choices.keys()].sort()).toEqual([...[0, 1, 2, 3, 4, 5, 6].map((index) => `listings/s${index}`), "listings/later1", "listings/later2", "users/u0", "users/u1", "users/u2"].sort());
    // No document exported twice: the cursor resumes strictly after (time, path).
    expect(check.lines).toBe(check.documents);
  });

  it("continues the rolling full across nights and completes a cycle", async () => {
    const db = database();
    const batch = db.batch();
    for (let index = 0; index < 5; index += 1) batch.set(db.doc(`auditLogs/a${index}`), { at: Timestamp.now() });
    for (let index = 0; index < 3; index += 1) batch.set(db.doc(`connectionLogs/c${index}`), { at: Timestamp.now() });
    for (let index = 0; index < 2; index += 1) batch.set(db.doc(`users/u${index}/private/account`), { phone: `+2126000000${index}` });
    await batch.commit();
    const config: Partial<BackupConfig> = {
      collections: [
        { id: "auditLogs", scope: "root", timeField: null },
        { id: "connectionLogs", scope: "root", timeField: null },
        { id: "private", scope: "group", timeField: null },
      ],
      fullBudget: 3,
      pageSize: 2,
      maxCycleMs: 1.5 * 86_400_000,
    };
    const store = new MemoryObjectStore();
    const start = new Date("2026-10-10T03:30:00Z");
    const night = (index: number) => new Date(start.getTime() + index * 86_400_000);
    const results = [];
    for (let index = 0; index < 4; index += 1) results.push(await runBackup({ db, store, recipient, now: night(index), config }));
    expect(results.map((result) => result.counts.full)).toEqual([{ auditLogs: 3 }, { auditLogs: 2, connectionLogs: 1 }, { connectionLogs: 2, private: 1 }, { private: 1 }]);
    expect(results.map((result) => result.cursors?.full.next)).toEqual(["auditLogs", "connectionLogs", "private", null]);
    // Night 3 (index 2): the unfinished cycle is older than maxCycleMs.
    expect(vi.mocked(alert).mock.calls.map(([event]) => event.title)).toEqual(["Sauvegarde Firestore : rotation complète trop lente"]);
    expect(results[3]?.cursors?.full.cycleStartedAt).toEqual(night(0));
    expect(results[3]?.cursors?.full.cycleCompletedAt).toEqual(night(3));
    const { plan, check } = await restore(store, database());
    expect(check.documents).toBe(10);
    expect(check.lines).toBe(10);
    // The cycle's NDJSON, summed over its four nights, is the Firestore storage estimate (x2).
    const cycleBytes = plan.parts.reduce((sum, part) => sum + (part.expected?.plainBytes ?? 0), 0);
    expect(cycleBytes).toBeGreaterThan(0);
    expect(results.map((result) => result.firestoreStorageBytes)).toEqual([null, null, null, 2 * cycleBytes]);
    expect(results[3]?.cursors?.full).toMatchObject({ cycleBytes, lastCycleBytes: cycleBytes });
    // The next night starts a new cycle; the estimate stays the last complete one.
    const fifth = await runBackup({ db, store, recipient, now: night(4), config });
    expect(fifth.counts.full).toEqual({ auditLogs: 3 });
    expect(fifth.cursors?.full.cycleStartedAt).toEqual(night(4));
    expect(fifth.cursors?.full.cycleBytes).toBeLessThan(cycleBytes);
    expect(fifth.firestoreStorageBytes).toBe(2 * cycleBytes);
  });

  it("leaves the cursors untouched when an upload fails, and the retry completes the backup", async () => {
    const db = database();
    const now = new Date();
    await seed(db, now);
    class FailingStore extends MemoryObjectStore {
      failAt = 2;
      private puts = 0;
      override async put(...args: Parameters<Store["put"]>): Promise<void> {
        this.puts += 1;
        if (this.puts === this.failAt) throw new Error("S3 put on joutiya-dev-private failed with HTTP 503");
        return super.put(...args);
      }
    }
    const store = new FailingStore();
    await expect(runBackup({ db, store, recipient, now })).rejects.toThrow(/HTTP 503/);
    expect((await db.doc("system/backup").get()).exists).toBe(false);
    expect(store.keys("private").some((key) => key.endsWith("manifest.json.age"))).toBe(false);

    store.failAt = 0;
    expect(await runBackup({ db, store, recipient, now })).toMatchObject({ status: "done" });
    const target = database();
    const { plan } = await restore(store, target);
    expect(plan.warnings).toEqual([]);
    expect(await dump(target)).toEqual(await dump(db));
  });

  it("stops scanning when the read quota is nearly used, and the next night catches up", async () => {
    const db = database();
    const now = new Date("2026-10-10T03:30:00Z");
    const batch = db.batch();
    for (let index = 0; index < 5; index += 1) batch.set(db.doc(`listings/l${index}`), { updatedAt: ago(now, 60_000 * (index + 20)) });
    for (let index = 0; index < 2; index += 1) batch.set(db.doc(`users/u${index}`), { updatedAt: ago(now, 60_000 * (index + 20)) });
    await batch.commit();
    const store = new MemoryObjectStore();
    const config: Partial<BackupConfig> = { collections: listingsAndUsers, pageSize: 2 };
    quota.level = "warning";
    quota.ratio = 0.95;
    const stopped = await runBackup({ db, store, recipient, now, config });
    expect(stopped).toMatchObject({ status: "done", truncated: true, quotaStopped: true });
    expect(stopped.counts.incremental).toEqual({ listings: 2 });
    expect(stopped.counts.full).toEqual({});
    expect(stopped.cursors?.full.next).toBe("listings");
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Sauvegarde Firestore incomplète : quota de lectures" }));

    quota.level = "ok";
    quota.ratio = 0.2;
    const next = await runBackup({ db, store, recipient, now: new Date(now.getTime() + 86_400_000), config });
    expect(next).toMatchObject({ truncated: false, quotaStopped: false });
    expect(next.counts.incremental).toEqual({ listings: 3, users: 2 });
    expect(next.counts.full).toEqual({ listings: 5, users: 2 });
    const { check } = await restore(store, database());
    expect(check.documents).toBe(7);
  });

  it("carries a purge (tombstone with updatedAt) in the next incremental, and the restore writes it over the listing", async () => {
    const db = database();
    const day1 = new Date("2026-10-10T03:30:00Z");
    await db.doc("listings/gone1").set({ title: "Vélo à purger", status: "expired", version: 4, updatedAt: ago(day1, 3_600_000) });
    await db.doc("listings/kept1").set({ title: "Vélo gardé", status: "published", version: 2, updatedAt: ago(day1, 3_600_000) });
    const store = new MemoryObjectStore();
    // No rolling full: only the incremental can carry the purge.
    const config: Partial<BackupConfig> = { collections: listingsAndUsers, fullBudget: 0 };
    expect((await runBackup({ db, store, recipient, now: day1, config })).counts.incremental).toEqual({ listings: 2, users: 0 });

    // retention-purge's tombstone (src/lib/db/repositories/retention.ts): no text, updatedAt = purgedAt.
    const purgedAt = Timestamp.fromDate(new Date(day1.getTime() + 20 * 3_600_000));
    await db.doc("listings/gone1").set({ status: "purged", purgedAt, version: 5, updatedAt: purgedAt });
    const day2 = new Date(day1.getTime() + 86_400_000);
    expect((await runBackup({ db, store, recipient, now: day2, config })).counts.incremental).toEqual({ listings: 1, users: 0 });

    const target = database();
    await restore(store, target);
    expect((await target.doc("listings/gone1").get()).data()).toEqual({ status: "purged", purgedAt, version: 5, updatedAt: purgedAt });
    expect((await target.doc("listings/kept1").get()).get("title")).toBe("Vélo gardé");
  });

  it("bounds one run's reads: the rolling full gets what the incremental left of maxRunReads", async () => {
    const db = database();
    const now = new Date("2026-10-10T03:30:00Z");
    const batch = db.batch();
    for (let index = 0; index < 4; index += 1) batch.set(db.doc(`listings/l${index}`), { updatedAt: ago(now, 60_000 * (index + 5)) });
    for (let index = 0; index < 4; index += 1) batch.set(db.doc(`users/u${index}`), { updatedAt: ago(now, 60_000 * (index + 5)) });
    await batch.commit();
    // 1 read for the cursor document, then pages of 10: listings (4 docs) and users (4 docs) leave 1 read.
    const result = await runBackup({ db, store: new MemoryObjectStore(), recipient, now, config: { collections: listingsAndUsers, pageSize: 10, maxRunReads: 10, fullBudget: 1_000 } });
    expect(result.counts.incremental).toEqual({ listings: 4, users: 4 });
    expect(result.counts.full).toEqual({ listings: 1 });
    expect(result.reads).toBeLessThanOrEqual(11);
    expect(result.cursors?.full.next).toBe("listings");
  });

  it("records the encrypted bytes of each night for the R2 gauge, forgetting nights past the 98-day lifecycle", async () => {
    const db = database();
    const now = new Date("2026-10-10T03:30:00Z");
    await db.doc("listings/l1").set({ updatedAt: ago(now, 60_000) });
    const expiredNight = new Date(now.getTime() - (BACKUP_RETENTION_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    await db.doc("system/backup").set({ storedBytes: { [expiredNight]: 9_999, "2026-10-09": 1_000 } });
    const store = new MemoryObjectStore();
    const result = await runBackup({ db, store, recipient, now, config: { collections: listingsAndUsers } });
    const written = (await Promise.all(store.keys("private").map(async (key) => ((await store.get("private", key)) as Buffer).byteLength))).reduce((sum, bytes) => sum + bytes, 0);
    expect(result.retainedBytes).toBe(1_000 + written);
    expect((await db.doc("system/backup").get()).get("storedBytes")).toEqual({ "2026-10-09": 1_000, "2026-10-10": written });
    expect(await readRetainedBackupBytes(db, now)).toBe(1_000 + written);
    // 98 days later the 2026-10-09 objects are gone from the bucket.
    expect(await readRetainedBackupBytes(db, new Date(Date.parse("2026-10-09T12:00:00Z") + (BACKUP_RETENTION_DAYS + 1) * 86_400_000))).toBe(written);
  });

  it("ignores hand-edited cursor paths that do not belong to their collection", async () => {
    const db = database();
    const now = new Date("2026-10-10T03:30:00Z");
    await db.doc("listings/l1").set({ updatedAt: ago(now, 60_000) });
    await db.doc("system/backup").set({
      incremental: { listings: { since: ago(now, 3_600_000), after: "users/u1" } },
      full: { next: "listings", after: { listings: "users/u1/private/account" } },
    });
    const result = await runBackup({ db, store: new MemoryObjectStore(), recipient, now, config: { collections: listingsAndUsers } });
    expect(result).toMatchObject({ status: "done" });
    expect(result.counts.incremental["listings"]).toBe(1);
    expect(result.counts.full["listings"]).toBe(1);
  });
});
