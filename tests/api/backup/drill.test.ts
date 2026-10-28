import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// D20 against the emulators: the nightly settings collection (config), the Firebase Auth export
// and its import without passwords, the restore drill's comparison and reference counts, and the
// freshness alert. The plain round trip and the cursors are in restore.test.ts.

vi.mock("@/lib/quota", () => ({
  consume: vi.fn(async (id: string) => ({ id, period: "p", used: 0, limit: 50_000, ratio: 0, level: "ok" })),
  isDegraded: vi.fn(async () => false),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

const { alert } = await import("@/lib/alert");
const { auth } = await import("@/lib/firebase/admin");
const { authUserLister, checkBackupFreshness, runBackup } = await import("@/lib/backup/export");
const { generateIdentity, identityToRecipient } = await import("@/lib/backup/crypto");
const { applyAuthRestore, applyRestore, checkRestore, planRestore, readAuthExport } = await import("@/lib/backup/restore");
const { canonicalJson, verifyRestore } = await import("@/lib/backup/drill");
const { MemoryObjectStore } = await import("@/lib/storage/memory");

type Store = InstanceType<typeof MemoryObjectStore>;
type AuthImportTarget = Parameters<typeof applyAuthRestore>[1];

const run = Date.now().toString(36);
let counter = 0;
let identity: string;
let recipient: string;

function database(): Firestore {
  counter += 1;
  return new Firestore({ projectId: process.env.FIREBASE_PROJECT_ID, databaseId: `drill-${run}-${counter}`, ignoreUndefinedProperties: true });
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

async function seed(db: Firestore, now: Date): Promise<void> {
  const at = Timestamp.fromDate(new Date(now.getTime() - 3_600_000));
  const batch = db.batch();
  batch.set(db.doc("users/u1"), { displayName: "Amina", updatedAt: at });
  batch.set(db.doc("listings/l1"), { ownerUid: "u1", title: "Vélo", updatedAt: at });
  // Its owner is not in the backup: a dangling reference, counted and not fatal.
  batch.set(db.doc("listings/l2"), { ownerUid: "ghost", title: "Table", updatedAt: at });
  batch.set(db.doc("uploads/up1"), { purpose: "listing", targetId: "l1", updatedAt: at });
  batch.set(db.doc("config/legal"), { legalForm: "EI", capital: null, cguVersion: "2026-10" });
  await batch.commit();
}

beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

beforeEach(() => {
  vi.mocked(alert).mockClear();
});

describe("canonicalJson", () => {
  it("gives the same text whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: [2, 1] })).not.toBe(canonicalJson({ a: [1, 2] }));
  });
});

describe("nightly config and the restore drill", () => {
  it("backs up config every night and the drill finds the restore identical, with the dangling references counted", async () => {
    const db = database();
    const now = new Date();
    await seed(db, now);
    const store = new MemoryObjectStore();
    const result = await runBackup({ db, store, recipient, now, config: { fullBudget: 0 } });
    // No rolling full tonight: config comes from the nightly read.
    expect(result.counts.incremental).toMatchObject({ config: 1, users: 1, listings: 2, uploads: 1 });
    expect(result.counts.full).toEqual({});

    const source = storeSource(store);
    const plan = await planRestore(source, identity);
    const check = await checkRestore(source, plan, identity);
    const target = database();
    await applyRestore(source, plan, check, identity, target);
    const report = await verifyRestore(source, plan, check, identity, target);
    expect(report.ok).toBe(true);
    expect(report.collections["config"]).toMatchObject({ expected: 1, restored: 1, missing: [], extra: [], different: [] });
    expect(report.collections["listings"]?.restoredSha256).toBe(report.collections["listings"]?.expectedSha256);
    expect(report.references).toEqual(
      expect.arrayContaining([
        { rule: "listings.ownerUid -> users", checked: 2, dangling: 1 },
        { rule: "uploads.targetId -> listings (purpose listing)", checked: 1, dangling: 0 },
      ]),
    );
    // The newest document write captured (the seed ran after `now`): the RPO counts from it.
    expect(report.newestCapture?.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(report.newestCapture?.getTime()).toBeLessThanOrEqual(Date.now());

    // A document changed or added after the restore fails the drill, and is named.
    await target.doc("listings/l1").update({ title: "Vélo modifié" });
    await target.doc("listings/l9").set({ ownerUid: "u1" });
    const changed = await verifyRestore(source, plan, check, identity, target);
    expect(changed.ok).toBe(false);
    expect(changed.collections["listings"]).toMatchObject({ different: ["listings/l1"], extra: ["listings/l9"] });
  });
});

describe("Firebase Auth export", () => {
  it("exports the accounts encrypted with the backup and recreates them without passwords", async () => {
    const email = `drill-${run}@joutiya.test`;
    const pro = await auth().createUser({ email, emailVerified: true, password: ["Porte", "Ocre", "2026"].join("-"), displayName: "Pro Drill" });
    await auth().setCustomUserClaims(pro.uid, { role: "pro" });
    const disabled = await auth().createUser({ email: `drill-off-${run}@joutiya.test`, disabled: true });
    const ours = new Set([pro.uid, disabled.uid]);

    const db = database();
    const store = new MemoryObjectStore();
    const now = new Date();
    const result = await runBackup({ db, store, recipient, now, authUsers: authUserLister(auth()), config: { collections: [] } });
    expect(result.status).toBe("done");
    expect(result.authUsers).toBeGreaterThanOrEqual(2);
    const date = now.toISOString().slice(0, 10);
    const authKeys = store.keys("private").filter((key) => key.includes("/auth/"));
    expect(authKeys).toEqual([`backups/${date}/auth/users.ndjson.gz.age`]);
    const body = (await store.get("private", authKeys[0] as string)) as Buffer;
    for (const plain of [email, "Pro Drill", pro.uid]) expect(body.includes(Buffer.from(plain))).toBe(false);

    // The Firestore restore ignores the Auth parts.
    const source = storeSource(store);
    expect((await planRestore(source, identity)).parts.some((part) => part.key.includes("/auth/"))).toBe(false);

    const exported = await readAuthExport(source, identity);
    expect(exported?.date).toBe(date);
    const users = (exported?.users ?? []).filter((user) => ours.has(user.uid));
    expect(users).toHaveLength(2);
    expect(users.find((user) => user.uid === pro.uid)).toMatchObject({ email, emailVerified: true, displayName: "Pro Drill", customClaims: { role: "pro" } });
    expect(Object.keys(users.find((user) => user.uid === pro.uid) ?? {})).not.toContain("passwordHash");

    await auth().deleteUsers([...ours]);
    const imported = await applyAuthRestore(users, auth() as unknown as AuthImportTarget);
    expect(imported).toEqual({ imported: 2, failed: [] });
    const restored = await auth().getUser(pro.uid);
    expect(restored).toMatchObject({ email, emailVerified: true, displayName: "Pro Drill", customClaims: { role: "pro" } });
    expect(restored.providerData.map((provider) => provider.providerId)).not.toContain("password");
    expect((await auth().getUser(disabled.uid)).disabled).toBe(true);
    await auth().deleteUsers([...ours]);
  });

  it("keeps the Firestore backup and alerts when the Auth export fails", async () => {
    const db = database();
    await db.doc("users/u1").set({ updatedAt: Timestamp.now() });
    const store = new MemoryObjectStore();
    const result = await runBackup({ db, store, recipient, authUsers: async () => Promise.reject(new Error("auth/internal-error")) });
    expect(result).toMatchObject({ status: "done", authUsers: null });
    expect(store.keys("private").some((key) => key.endsWith("manifest.json.age"))).toBe(true);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Sauvegarde des comptes Firebase Auth en échec" }));
    expect(await readAuthExport(storeSource(store), identity)).toBeNull();
  });
});

describe("scripts/restore-drill.ts", () => {
  it("restores a downloaded backup into a fresh emulator project and reports a passed drill, counts only", async () => {
    const pro = await auth().createUser({ email: `drill-script-${run}@joutiya.test`, emailVerified: true });
    const db = database();
    await seed(db, new Date());
    const store = new MemoryObjectStore();
    await runBackup({ db, store, recipient, authUsers: authUserLister(auth()) });
    const dir = await mkdtemp(join(tmpdir(), "joutiya-drill-"));
    try {
      for (const key of store.keys("private")) {
        await mkdir(join(dir, "dl", dirname(key)), { recursive: true });
        await writeFile(join(dir, "dl", key), (await store.get("private", key)) as Buffer);
      }
      await writeFile(join(dir, "key.txt"), `${identity}\n`);
      await chmod(join(dir, "key.txt"), 0o600);
      const { stdout } = await promisify(execFile)(process.execPath, ["scripts/restore-drill.ts", "--identity", join(dir, "key.txt"), "--from", join(dir, "dl")], {
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
          FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
          METADATA_SERVER_DETECTION: "none",
        },
      });
      expect(stdout).toMatch(/target demo-drill-\d{14} \(Firestore emulator and Auth emulator\)/);
      expect(stdout).toMatch(/config: 1\/1 identical/);
      expect(stdout).toContain("listings.ownerUid -> users: 1 dangling of 2");
      expect(stdout).toMatch(/Firebase Auth \(\d{4}-\d{2}-\d{2}\): (\d+)\/\1 accounts restored/);
      expect(stdout).toMatch(/^RTO: /m);
      expect(stdout).toMatch(/^RPO: /m);
      expect(stdout).toContain("Drill passed.");
      for (const secret of [identity, "Amina", "Vélo", pro.email as string]) expect(stdout).not.toContain(secret);

      // restore-firestore.ts --auth recreates the accounts with the documents.
      const project = `demo-auth-${run}`;
      const restored = await promisify(execFile)(process.execPath, ["scripts/restore-firestore.ts", "--identity", join(dir, "key.txt"), "--from", join(dir, "dl"), "--project", project, "--auth", "--apply"], {
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST, METADATA_SERVER_DETECTION: "none" },
      });
      const accounts = /Firebase Auth export of \d{4}-\d{2}-\d{2}: (\d+) accounts to recreate/.exec(restored.stdout)?.[1];
      expect(Number(accounts)).toBeGreaterThanOrEqual(1);
      expect(restored.stdout).toContain(`${accounts} Firebase Auth accounts recreated.`);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await auth().deleteUser(pro.uid);
    }
  });

  it("refuses to run outside the emulator", async () => {
    const failure = await promisify(execFile)(process.execPath, ["scripts/restore-drill.ts", "--identity", "key.txt", "--from", "dl"], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } }).catch(
      (error: { stderr: string }) => error,
    );
    expect((failure as { stderr: string }).stderr).toContain("the drill restores into the local emulator only");
  });
});

describe("backup freshness", () => {
  it("alerts when the last completed run is over 26 hours old, never before the first one", async () => {
    const db = database();
    const now = new Date("2026-10-20T09:05:00Z");
    expect(await checkBackupFreshness(db, now)).toEqual({ lastRunAt: null, stale: false });
    await db.doc("system/backup").set({ lastRunAt: Timestamp.fromDate(new Date("2026-10-20T03:31:00Z")) });
    expect((await checkBackupFreshness(db, now)).stale).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    await db.doc("system/backup").set({ lastRunAt: Timestamp.fromDate(new Date("2026-10-19T03:31:00Z")) });
    expect((await checkBackupFreshness(db, now)).stale).toBe(true);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: "Sauvegarde Firestore trop ancienne" }));
  });
});
