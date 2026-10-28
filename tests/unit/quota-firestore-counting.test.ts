import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";

// Every Firestore operation of the account, staff, journal and suppression modules is counted
// against the Spark quotas (§2 "Garde-fous de quotas"): reads, writes and deletes as Firestore
// bills them. A small in-memory Firestore stands in for the Admin SDK.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/observability/capture", () => ({ captureServerException: vi.fn() }));

type Data = Record<string, unknown>;
const docs = new Map<string, Data>();
let autoId = 0;

interface FakeDoc {
  path: string;
  id: string;
  collection: (name: string) => FakeCollection;
  get: () => Promise<FakeSnapshot>;
  set: (data: Data, options?: { merge?: boolean }) => Promise<void>;
  update: (data: Data) => Promise<void>;
  create: (data: Data) => Promise<void>;
  delete: () => Promise<void>;
}
interface FakeSnapshot {
  exists: boolean;
  id: string;
  ref: FakeDoc;
  data: () => Data | undefined;
  get: (field: string) => unknown;
}
interface FakeQuery {
  where: (...args: unknown[]) => FakeQuery;
  orderBy: (...args: unknown[]) => FakeQuery;
  limit: (n: number) => FakeQuery;
  select: (...fields: string[]) => FakeQuery;
  get: () => Promise<{ docs: FakeSnapshot[]; size: number; empty: boolean }>;
}
interface FakeCollection extends FakeQuery {
  doc: (id?: string) => FakeDoc;
  add: (data: Data) => Promise<FakeDoc>;
}

function snapshot(path: string): FakeSnapshot {
  const data = docs.get(path);
  return { exists: data !== undefined, id: path.split("/").pop() ?? "", ref: doc(path), data: () => data, get: (field) => data?.[field] };
}

function doc(path: string): FakeDoc {
  return {
    path,
    id: path.split("/").pop() ?? "",
    collection: (name) => collection(`${path}/${name}`),
    get: async () => snapshot(path),
    set: async (data, options) => void docs.set(path, options?.merge ? { ...docs.get(path), ...data } : data),
    update: async (data) => void docs.set(path, { ...docs.get(path), ...data }),
    create: async (data) => void docs.set(path, data),
    delete: async () => void docs.delete(path),
  };
}

/** Filters are ignored: each test seeds only the documents its query must return. */
function collection(path: string): FakeCollection {
  let max = Infinity;
  const query: FakeQuery = {
    where: () => query,
    orderBy: () => query,
    limit: (n) => ((max = n), query),
    select: () => query,
    get: async () => {
      const children = [...docs.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).slice(0, max);
      const found = children.map(snapshot);
      return { docs: found, size: found.length, empty: found.length === 0 };
    },
  };
  return {
    ...query,
    doc: (id) => doc(`${path}/${id ?? `auto${(autoId += 1)}`}`),
    add: async (data) => {
      const ref = doc(`${path}/auto${(autoId += 1)}`);
      docs.set(ref.path, data);
      return ref;
    },
  };
}

const transaction = {
  get: async (ref: FakeDoc) => ref.get(),
  create: (ref: FakeDoc, data: Data) => void docs.set(ref.path, data),
  set: (ref: FakeDoc, data: Data) => void docs.set(ref.path, data),
  update: (ref: FakeDoc, data: Data) => void docs.set(ref.path, { ...docs.get(ref.path), ...data }),
  delete: (ref: FakeDoc) => void docs.delete(ref.path),
};
const fakeDb = {
  collection,
  runTransaction: async <T>(run: (tx: typeof transaction) => Promise<T>) => run(transaction),
  batch: () => {
    const pending: FakeDoc[] = [];
    return { delete: (ref: FakeDoc) => void pending.push(ref), commit: async () => pending.forEach((ref) => docs.delete(ref.path)) };
  },
};
vi.mock("@/lib/firebase/admin", () => ({ db: () => fakeDb, isFirebaseConfigured: () => true, isFirestoreConfigured: () => true }));

const { consume } = await import("@/lib/quota");
const { captureServerException } = await import("@/lib/observability/capture");
const users = await import("@/lib/db/repositories/users");
const staff = await import("@/lib/db/repositories/staff");
const quotaDaily = await import("@/lib/db/repositories/quota-daily");
const suppressions = await import("@/lib/mail/suppressions");
const { audit } = await import("@/lib/audit");
const connectionLogs = await import("@/lib/logging/connection-logs");

/** Units consumed per quota since the last reset. */
function used(): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [id, amount] of vi.mocked(consume).mock.calls) totals[id] = (totals[id] ?? 0) + (amount ?? 1);
  return totals;
}

const NOW = new Date("2026-10-16T10:00:00Z");

beforeEach(() => {
  docs.clear();
  vi.mocked(consume).mockClear();
});

describe("users repository", () => {
  const input = {
    uid: "uid-1",
    email: "Yasmine@Example.com",
    displayName: "Yasmine",
    locale: "fr" as const,
    consents: { cguVersion: "2026-10", transfersVersion: "2026-10", marketing: false },
    provider: "password" as const,
    now: NOW,
  };

  it("counts the account creation: the index read, three documents", async () => {
    await users.createAccountDocuments(input);
    expect(used()).toEqual({ "firestore.reads": 1, "firestore.writes": 3 });
    vi.mocked(consume).mockClear();
    // A taken e-mail reads the index and writes nothing.
    await expect(users.createAccountDocuments({ ...input, uid: "uid-2" })).rejects.toBeInstanceOf(users.EmailTakenError);
    expect(used()).toEqual({ "firestore.reads": 1 });
  });

  it("counts one read per lookup, missing documents included", async () => {
    await users.findUidByEmail("nobody@example.com");
    await users.getUser("uid-x");
    await users.getUserPrivate("uid-x");
    expect(used()).toEqual({ "firestore.reads": 3 });
  });

  it("counts one write per account update", async () => {
    await users.createAccountDocuments(input);
    vi.mocked(consume).mockClear();
    await users.activateAccount("uid-1", NOW);
    await users.linkProvider("uid-1", "google.com");
    await users.unlinkProvider("uid-1", "password");
    await users.updateDisplayName("uid-1", "Yasmine B", NOW);
    await users.updateLocale("uid-1", "ar", NOW);
    expect(used()).toEqual({ "firestore.writes": 5 });
  });

  it("counts the pending-account query by documents returned, one read when empty", async () => {
    await users.listPendingAccounts(NOW);
    expect(used()).toEqual({ "firestore.reads": 1 });
    await users.createAccountDocuments(input);
    await users.createAccountDocuments({ ...input, uid: "uid-2", email: "other@example.com" });
    vi.mocked(consume).mockClear();
    expect(await users.listPendingAccounts(NOW)).toHaveLength(2);
    expect(used()).toEqual({ "firestore.reads": 2 });
  });

  it("counts the reads of the pending purge (its deletions are counted by purge-unactivated)", async () => {
    await users.createAccountDocuments(input);
    vi.mocked(consume).mockClear();
    expect(await users.deleteAccountDocumentsIfPending("uid-1")).toBe(true);
    expect(used()).toEqual({ "firestore.reads": 3 });
    vi.mocked(consume).mockClear();
    expect(await users.deleteAccountDocumentsIfPending("uid-1")).toBe(false);
    expect(used()).toEqual({ "firestore.reads": 2 });
  });

  it("counts the deletions of a closed account (a transaction: the private document, then the index it names)", async () => {
    await users.createAccountDocuments(input);
    vi.mocked(consume).mockClear();
    await users.deleteAccountDocuments("uid-1");
    // Two reads now (the index is read inside the transaction before its deletion), three deletions.
    expect(used()).toEqual({ "firestore.reads": 2, "firestore.deletes": 3 });
    expect(docs.size).toBe(0);
  });

  it("keeps an e-mail index entry that another account took over (re-registration between closure steps)", async () => {
    await users.createAccountDocuments(input);
    const indexPath = `emailIndex/${users.emailNormHash(input.email)}`;
    docs.set(indexPath, { uid: "uid-2", createdAt: NOW });
    vi.mocked(consume).mockClear();
    await users.deleteAccountDocuments("uid-1");
    expect(used()).toEqual({ "firestore.reads": 2, "firestore.deletes": 2 });
    expect([...docs.keys()]).toEqual([indexPath]);
  });

  it("parses what it reads: a drifted document reads as absent and is reported by uid and paths, never values", async () => {
    await users.createAccountDocuments(input);
    expect(await users.getUser("uid-1")).toMatchObject({ displayName: "Yasmine", activation: "pending", createdAt: NOW });
    expect(await users.getUserPrivate("uid-1")).toMatchObject({ email: "yasmine@example.com", providers: ["password"] });
    expect(captureServerException).not.toHaveBeenCalled();

    docs.set("users/uid-bad", { displayName: "Drifted", type: "individual" });
    docs.set("users/uid-bad/private/account", { email: "secret@example.com", providers: ["password"] });
    expect(await users.getUser("uid-bad")).toBeNull();
    expect(await users.getUserPrivate("uid-bad")).toBeNull();
    expect(captureServerException).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(captureServerException).mock.calls;
    const [userError, userContext] = calls[0]!;
    const [privateError, privateContext] = calls[1]!;
    expect((userError as Error).message).toBe("invalid users document");
    expect(userContext).toMatchObject({ uid: "uid-bad", issues: expect.arrayContaining(["publicId", "badges", "stats"]) });
    expect((privateError as Error).message).toBe("invalid private document");
    expect(privateContext).toMatchObject({ uid: "uid-bad", issues: expect.arrayContaining(["emailNormHash", "consents"]) });
    expect(JSON.stringify([userContext, privateContext])).not.toContain("secret@");
    expect(JSON.stringify([userContext, privateContext])).not.toContain("Drifted");
  });
});

describe("staff repository", () => {
  it("counts the roster reads and writes", async () => {
    await staff.upsertStaff({ uid: "staff-1", email: "mod@joutiya.ma", displayName: "Modération", role: "moderator", invitedBy: "script", now: NOW });
    expect(used()).toEqual({ "firestore.reads": 1, "firestore.writes": 1 });
    vi.mocked(consume).mockClear();
    await staff.revokeStaff("staff-1", NOW);
    await staff.getStaff("staff-1");
    await staff.listStaff();
    expect(used()).toEqual({ "firestore.reads": 2, "firestore.writes": 1 });
  });

  it("lists the active admins (revoked ones excluded) and counts the query by documents returned", async () => {
    // The fake ignores the role filter (Firestore applies it): admins only are seeded.
    expect(await staff.listActiveAdmins()).toEqual([]);
    expect(used()).toEqual({ "firestore.reads": 1 });
    await staff.upsertStaff({ uid: "admin-1", email: "a1@joutiya.ma", displayName: "Admin Un", role: "admin", invitedBy: "script", now: NOW });
    await staff.upsertStaff({ uid: "admin-2", email: "a2@joutiya.ma", displayName: "Admin Deux", role: "admin", invitedBy: "admin-1", now: NOW });
    await staff.revokeStaff("admin-2", NOW);
    vi.mocked(consume).mockClear();
    expect((await staff.listActiveAdmins()).map((admin) => admin.uid)).toEqual(["admin-1"]);
    expect(used()).toEqual({ "firestore.reads": 2 });
  });
});

describe("quotaDaily repository", () => {
  it("writes the nightly snapshot through the typed collection and counts one write", async () => {
    const quotas = { "firestore.reads": { period: "2026-10-15", used: 1234, limit: 50_000, ratio: 0.0247, level: "ok" as const } };
    await quotaDaily.writeQuotaDaily({ date: "2026-10-15", quotas, createdAt: NOW });
    expect(used()).toEqual({ "firestore.writes": 1 });
    const stored = docs.get("quotaDaily/2026-10-15");
    expect(stored).toMatchObject({ date: "2026-10-15", quotas });
    expect((stored?.["createdAt"] as Timestamp).toDate()).toEqual(NOW);
    // The schema is strict: a snapshot with an unknown field never reaches Firestore.
    await expect(quotaDaily.writeQuotaDaily({ date: "2026-10-15", quotas, createdAt: NOW, extra: 1 } as never)).rejects.toThrow();
  });
});

describe("journals and suppressions", () => {
  it("counts one write per audit entry and per connection log", async () => {
    await audit({ actorUid: "system", actorRole: "system", action: "listing.purge", target: { type: "listing", id: "abc" }, automated: true, at: NOW });
    await connectionLogs.logConnection({ uid: "uid-1", event: "login", ip: "203.0.113.7", at: NOW });
    expect(used()).toEqual({ "firestore.writes": 2 });
  });

  it("counts the suppression lookup, insertion and removal", async () => {
    expect(await suppressions.isSuppressed("a@example.com")).toBe(false);
    await suppressions.addSuppression("a@example.com", "bounce", "resend", NOW);
    expect(await suppressions.isSuppressed("a@example.com")).toBe(true);
    await suppressions.removeSuppression("a@example.com");
    expect(used()).toEqual({ "firestore.reads": 2, "firestore.writes": 1, "firestore.deletes": 1 });
  });
});

describe("connection log retention", () => {
  it("keeps an entry one calendar year, leap day included", async () => {
    expect(connectionLogs.connectionLogPurgeAt(NOW).toISOString()).toBe("2027-10-16T10:00:00.000Z");
    // 365 days after 1 March 2027 would be 29 February 2028: one day short of a year.
    expect(connectionLogs.connectionLogPurgeAt(new Date("2027-03-01T08:00:00Z")).toISOString()).toBe("2028-03-01T08:00:00.000Z");
    await connectionLogs.logConnection({ uid: "uid-1", event: "signup", ip: "203.0.113.7", at: NOW });
    const [stored] = [...docs.values()];
    expect((stored?.["purgeAt"] as Timestamp).toDate().toISOString()).toBe("2027-10-16T10:00:00.000Z");
  });

  it("deletes one batch past purgeAt and counts its reads and deletions", async () => {
    for (let i = 0; i < 3; i += 1) docs.set(`connectionLogs/old${i}`, { purgeAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")) });
    expect(await connectionLogs.deleteConnectionLogsPastPurge(NOW, 2)).toBe(2);
    expect(used()).toEqual({ "firestore.reads": 2, "firestore.deletes": 2 });
    expect(docs.size).toBe(1);
    vi.mocked(consume).mockClear();
    expect(await connectionLogs.oldestConnectionLogPastPurge(NOW)).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(await connectionLogs.deleteConnectionLogsPastPurge(NOW, 500)).toBe(1);
    // An empty query still bills one read; a zero limit queries nothing.
    expect(await connectionLogs.deleteConnectionLogsPastPurge(NOW, 500)).toBe(0);
    expect(await connectionLogs.deleteConnectionLogsPastPurge(NOW, 0)).toBe(0);
    expect(await connectionLogs.oldestConnectionLogPastPurge(NOW)).toBeNull();
    expect(used()).toEqual({ "firestore.reads": 4, "firestore.deletes": 1 });
  });
});
