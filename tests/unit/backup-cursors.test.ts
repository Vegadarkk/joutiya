import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  BACKUP_COLLECTIONS,
  BACKUP_RETENTION_DAYS,
  DEFAULT_BACKUP_CONFIG,
  EMPTY_CURSORS,
  firestoreStorageEstimate,
  parseCursors,
  retainedStoredBytes,
  serializeCursors,
  sumRetainedBytes,
  type BackupCursors,
} from "@/lib/backup/export";
import { COLLECTIONS } from "@/lib/db/schemas";

// system/backup (D17): the cursors survive a write/read cycle, and a missing or hand-edited
// document never breaks the nightly job.

const cursors: BackupCursors = {
  incremental: {
    users: { since: new Timestamp(1_792_000_000, 123_456_000), after: "users/u9" },
    listings: { since: new Timestamp(1_792_000_100, 0), after: null },
  },
  incrementalNext: "listings",
  full: {
    next: "auditLogs",
    after: { auditLogs: "auditLogs/a42", private: "users/u3/private/account" },
    cycleStartedAt: new Date("2026-10-10T03:30:00Z"),
    cycleCompletedAt: new Date("2026-10-09T03:31:00Z"),
    cycleBytes: 4_500_000,
    lastCycleBytes: 12_000_000,
  },
  lastRunAt: new Date("2026-10-16T03:30:00Z"),
  lastDate: "2026-10-16",
  storedBytes: { "2026-10-15": 1_200_000, "2026-10-16": 1_300_000 },
};

describe("backup cursors", () => {
  it("round-trips through the stored document, keeping Firestore precision on the incremental bounds", () => {
    const stored = serializeCursors(cursors, new Date("2026-10-16T03:31:00Z"));
    expect((stored["updatedAt"] as Timestamp).toDate().toISOString()).toBe("2026-10-16T03:31:00.000Z");
    expect(parseCursors(stored)).toEqual(cursors);
    const users = parseCursors(stored).incremental["users"];
    expect(users?.since.nanoseconds).toBe(123_456_000);
  });

  it("starts empty without a document or with garbage", () => {
    for (const data of [undefined, null, 42, "x", []]) expect(parseCursors(data)).toEqual(EMPTY_CURSORS);
    expect(parseCursors({ incremental: "x", full: 3, lastDate: 7 })).toEqual(EMPTY_CURSORS);
  });

  it("keeps the valid entries of a hand-edited document only", () => {
    const parsed = parseCursors({
      incremental: {
        users: { since: new Date("2026-10-15T00:00:00Z"), after: "users" },
        listings: { since: "2026-10-15" },
        uploads: "nope",
        staff: { since: new Timestamp(10, 0), after: "staff/s1" },
      },
      incrementalNext: 5,
      full: { next: "users", after: { users: "users/u1", listings: "listings", uploads: 3 }, cycleStartedAt: "hier", cycleCompletedAt: new Date("invalid"), cycleBytes: -1, lastCycleBytes: "9" },
      lastRunAt: new Timestamp(20, 0),
      lastDate: "16/10/2026",
    });
    expect(parsed.incremental).toEqual({ users: { since: Timestamp.fromDate(new Date("2026-10-15T00:00:00Z")), after: null }, staff: { since: new Timestamp(10, 0), after: "staff/s1" } });
    expect(parsed.incrementalNext).toBeNull();
    expect(parsed.full).toEqual({ next: "users", after: { users: "users/u1" }, cycleStartedAt: null, cycleCompletedAt: null, cycleBytes: null, lastCycleBytes: null });
    expect(parseCursors({ full: { cycleBytes: 0, lastCycleBytes: 1.5 } }).full).toMatchObject({ cycleBytes: 0, lastCycleBytes: null });
    expect(parsed.lastRunAt?.getTime()).toBe(20_000);
    expect(parsed.lastDate).toBeNull();
    expect(parseCursors({ storedBytes: { "2026-10-15": 10, "2026-10-16": -1, "16/10/2026": 3, "2026-10-14": "9", "2026-10-13": 1.5 } }).storedBytes).toEqual({ "2026-10-15": 10 });
  });

  it("counts the backup bytes still in the private bucket (98-day lifecycle) for the R2 gauge", () => {
    const now = new Date("2026-10-16T03:30:00Z");
    const oldest = new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    const gone = new Date(now.getTime() - (BACKUP_RETENTION_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const stored = { [gone]: 5_000, [oldest]: 100, "2026-10-15": 20, "2026-10-16": 3 };
    expect(retainedStoredBytes(stored, now)).toEqual({ [oldest]: 100, "2026-10-15": 20, "2026-10-16": 3 });
    expect(sumRetainedBytes(stored, now)).toBe(123);
    expect(sumRetainedBytes({}, now)).toBe(0);
  });

  it("estimates the Firestore storage as twice the NDJSON of a complete cycle (documents plus index entries)", () => {
    expect(firestoreStorageEstimate(350_000_000)).toBe(700_000_000);
    expect(firestoreStorageEstimate(0)).toBe(0);
  });

  it("keeps one night's reads well below the daily quota: stop at 75 %, at most 40 % per run", () => {
    expect(DEFAULT_BACKUP_CONFIG.readsStopRatio).toBe(0.75);
    expect(DEFAULT_BACKUP_CONFIG.maxRunReads).toBe(20_000);
    expect(DEFAULT_BACKUP_CONFIG.fullBudget).toBeLessThanOrEqual(DEFAULT_BACKUP_CONFIG.maxRunReads);
  });

  it("backs up every collection but the cursors themselves, once", () => {
    const ids = BACKUP_COLLECTIONS.map((collection) => collection.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(COLLECTIONS.system);
    expect(ids).not.toContain(COLLECTIONS.userPrivateDoc);
    // A document id, not a collection: users/{uid}/private/identity goes with the `private` group.
    expect(ids).not.toContain(COLLECTIONS.userIdentityDoc);
    const excluded: string[] = [COLLECTIONS.system, COLLECTIONS.userPrivateDoc, COLLECTIONS.userIdentityDoc];
    const expected = Object.values(COLLECTIONS).filter((id) => !excluded.includes(id));
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(BACKUP_COLLECTIONS.find((collection) => collection.id === "private")).toEqual({ id: "private", scope: "group", timeField: null });
  });
});
