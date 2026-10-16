import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { BACKUP_COLLECTIONS, EMPTY_CURSORS, parseCursors, serializeCursors, type BackupCursors } from "@/lib/backup/export";
import { COLLECTIONS } from "@/lib/db/schemas";

// system/backup (D17): the cursors survive a write/read cycle, and a missing or hand-edited
// document never breaks the nightly job.

const cursors: BackupCursors = {
  incremental: {
    users: { since: new Timestamp(1_792_000_000, 123_456_000), after: "users/u9" },
    listings: { since: new Timestamp(1_792_000_100, 0), after: null },
  },
  incrementalNext: "listings",
  full: { next: "auditLogs", after: { auditLogs: "auditLogs/a42", private: "users/u3/private/account" }, cycleStartedAt: new Date("2026-10-10T03:30:00Z"), cycleCompletedAt: new Date("2026-10-09T03:31:00Z") },
  lastRunAt: new Date("2026-10-16T03:30:00Z"),
  lastDate: "2026-10-16",
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
      full: { next: "users", after: { users: "users/u1", listings: "listings", uploads: 3 }, cycleStartedAt: "hier", cycleCompletedAt: new Date("invalid") },
      lastRunAt: new Timestamp(20, 0),
      lastDate: "16/10/2026",
    });
    expect(parsed.incremental).toEqual({ users: { since: Timestamp.fromDate(new Date("2026-10-15T00:00:00Z")), after: null }, staff: { since: new Timestamp(10, 0), after: "staff/s1" } });
    expect(parsed.incrementalNext).toBeNull();
    expect(parsed.full).toEqual({ next: "users", after: { users: "users/u1" }, cycleStartedAt: null, cycleCompletedAt: null });
    expect(parsed.lastRunAt?.getTime()).toBe(20_000);
    expect(parsed.lastDate).toBeNull();
  });

  it("backs up every collection but the cursors themselves, once", () => {
    const ids = BACKUP_COLLECTIONS.map((collection) => collection.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(COLLECTIONS.system);
    expect(ids).not.toContain(COLLECTIONS.userPrivateDoc);
    const expected = Object.values(COLLECTIONS).filter((id) => id !== COLLECTIONS.system && id !== COLLECTIONS.userPrivateDoc);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(BACKUP_COLLECTIONS.find((collection) => collection.id === "private")).toEqual({ id: "private", scope: "group", timeField: null });
  });
});
