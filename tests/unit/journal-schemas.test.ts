import { describe, expect, it } from "vitest";
import { COLLECTIONS, connectionLogSchema, quotaDailySchema } from "@/lib/db/schemas";

// Journals of §5 kept to their field list: the connection log (décret 2021-1362) and the nightly
// quota snapshot are strict schemas, so nothing beyond the data map reaches Firestore.

describe("connectionLogSchema", () => {
  const entry = { uid: "uid-1", event: "login", ip: "203.0.113.7", at: new Date("2026-10-16T10:00:00Z"), purgeAt: new Date("2027-10-16T10:00:00Z") };

  it("keeps exactly the fields of §5: a user agent is refused (data minimisation)", () => {
    expect(connectionLogSchema.safeParse(entry).success).toBe(true);
    expect(connectionLogSchema.safeParse({ ...entry, userAgent: "Mozilla/5.0" }).success).toBe(false);
    expect(connectionLogSchema.safeParse({ ...entry, event: "profile_view" }).success).toBe(false);
  });
});

describe("quotaDailySchema", () => {
  const snapshot = { period: "2026-10-15", used: 1234, limit: 50_000, ratio: 0.0247, level: "ok" };
  const doc = { date: "2026-10-15", quotas: { "firestore.reads": snapshot, "resend.daily": { ...snapshot, level: "unknown" } }, createdAt: new Date("2026-10-16T00:05:00Z") };

  it("is registered as a typed collection and accepts the nightly snapshot", () => {
    expect(COLLECTIONS.quotaDaily).toBe("quotaDaily");
    expect(quotaDailySchema.safeParse(doc).success).toBe(true);
  });

  it("refuses unknown fields, a malformed date and an unknown level", () => {
    expect(quotaDailySchema.safeParse({ ...doc, extra: 1 }).success).toBe(false);
    expect(quotaDailySchema.safeParse({ ...doc, date: "15/10/2026" }).success).toBe(false);
    expect(quotaDailySchema.safeParse({ ...doc, quotas: { "firestore.reads": { ...snapshot, level: "critical" } } }).success).toBe(false);
    expect(quotaDailySchema.safeParse({ ...doc, quotas: { "firestore.reads": { ...snapshot, used: -1 } } }).success).toBe(false);
  });
});
