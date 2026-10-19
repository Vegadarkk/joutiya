import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Moderation statistics (design D24, "SLA targets visible") against the Firebase emulators: open
// reports per priority with the overdue ones, median time to decision over 30 days, appeal
// reversal rate over 90 days, open authority requests. Staff only.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { GET as statsRoute } from "@/app/api/admin/stats/route";
import { slaDueAt, type ReportPriority } from "@/config/report-reasons";
import type { ModerationStats } from "@/lib/decisions/contracts";
import { computeModerationStats } from "@/lib/decisions/stats";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, reportSchema, type ReportDoc } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import * as limiter from "@/lib/rate-limit/limiter";
import { member } from "../../reports/helpers";
import { adminCall, publicCall, staff, type Staff } from "./helpers";

const HOUR = 3_600_000;
let moderator: Staff;
let seeded = 0;

async function seedReport(priority: ReportPriority, createdAt: Date, status: ReportDoc["status"], closedAfterHours?: number): Promise<void> {
  seeded += 1;
  const doc = reportSchema.parse({
    target: { type: "user", id: `stats-${Date.now()}-${seeded}`, ownerUid: `stats-${seeded}` },
    reasonId: ({ P0: "threat", P1: "scam", P2: "harassment", P3: "spam" } as const)[priority],
    priority,
    explanation: "Seeded for the statistics.",
    goodFaith: true,
    source: "user",
    reporter: { locale: "fr", ipPrefixHash: "h", deviceHash: "h", trusted: false },
    hidden: false,
    status,
    ...(status === "actioned" || status === "dismissed" ? { outcome: status === "actioned" ? "founded" : "unfounded", closedAt: new Date(createdAt.getTime() + (closedAfterHours ?? 1) * HOUR) } : {}),
    slaDueAt: slaDueAt(priority, createdAt),
    createdAt,
    updatedAt: createdAt,
    purgeAt: new Date(createdAt.getTime() + 5 * 365 * 24 * HOUR),
  });
  await db().collection(COLLECTIONS.reports).doc().set(datesToTimestamps(doc));
}

beforeAll(async () => {
  resetServerEnv();
  moderator = await staff("moderator");
});

beforeEach(() => {
  limiter.resetRateLimiters();
});

describe("moderation stats", () => {
  it("count open and overdue reports per priority and the median time to decision", async () => {
    const before = await computeModerationStats();
    const now = Date.now();
    await seedReport("P3", new Date(now - 10 * 24 * HOUR), "open");
    await seedReport("P3", new Date(now - HOUR), "in_review");
    await seedReport("P1", new Date(now - 2 * HOUR), "actioned", 4);
    const after = await computeModerationStats();
    expect(after.open.P3.count - before.open.P3.count).toBe(2);
    expect(after.open.P3.overdue - before.open.P3.overdue).toBe(1);
    expect(after.decided30d.P1.count - before.decided30d.P1.count).toBe(1);
    expect(after.decided30d.P1.medianHours).not.toBeNull();
    expect(typeof after.sampled).toBe("boolean");
    expect(after.appeals.reversalRate === null || (after.appeals.reversalRate >= 0 && after.appeals.reversalRate <= 1)).toBe(true);
    expect(after.authorities.open).toBeGreaterThanOrEqual(0);
  });

  it("are served to staff only", async () => {
    const served = await adminCall<{ stats: ModerationStats }>(statsRoute, "GET", "/api/admin/stats", { as: moderator });
    expect(served.status).toBe(200);
    expect(Object.keys(served.body.stats.open)).toEqual(["P0", "P1", "P2", "P3"]);
    expect(served.body.stats.generatedAt).toMatch(/^\d{4}-/);
    expect((await publicCall(statsRoute, "GET", "/api/admin/stats", { as: await member() })).status).toBe(404);
    expect((await adminCall(statsRoute, "GET", "/api/admin/stats")).status).toBe(401);
  });
});
