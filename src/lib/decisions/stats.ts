import "server-only";
import { Timestamp, type Query } from "firebase-admin/firestore";
import { REPORT_PRIORITIES, type ReportPriority } from "@/config/report-reasons";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { aggregationReads, consume } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { APPEAL_SLA_DAYS, type ModerationStats } from "./contracts";
import { decisionsCol, reportsCol } from "./repository";

// Moderation statistics of the back office (design D24, transparency): open reports per priority
// and how many are past due, median time to decision per priority over 30 days, appeal reversal
// rate over 90 days, open authority requests. Count aggregations (one read per 1 000 entries)
// and one bounded sample for the medians; cached 5 minutes in Valkey (fail open: computed
// directly when Valkey is absent or down).

const CACHE_KEY = "decisions:stats:v1";
export const STATS_CACHE_SECONDS = 300;
/** Closed reports read for the medians (newest first). */
export const STATS_SAMPLE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ["open", "in_review"];
const CLOSED = ["actioned", "dismissed"];

async function count(query: Query): Promise<number> {
  const snapshot = await query.count().get();
  const value = snapshot.data().count;
  void consume("firestore.reads", aggregationReads(value));
  return value;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value * 10) / 10;
}

const byPriority = <T>(make: (priority: ReportPriority) => T) => Object.fromEntries(REPORT_PRIORITIES.map((priority) => [priority, make(priority)])) as Record<ReportPriority, T>;

/** Computes the statistics from Firestore (no cache). */
export async function computeModerationStats(now = new Date()): Promise<ModerationStats> {
  const reports = reportsCol();
  const nowTs = Timestamp.fromDate(now);
  const open = await Promise.all(
    REPORT_PRIORITIES.map(async (priority) => {
      const base = reports.where("status", "in", OPEN).where("priority", "==", priority);
      const [total, overdue] = await Promise.all([count(base), count(base.where("slaDueAt", "<", nowTs))]);
      return [priority, { count: total, overdue }] as const;
    }),
  );

  // Reports received in the last 30 days and decided (index status asc, createdAt desc).
  const since30 = Timestamp.fromDate(new Date(now.getTime() - 30 * DAY_MS));
  const sample = await reports.where("status", "in", CLOSED).where("createdAt", ">=", since30).orderBy("createdAt", "desc").select("priority", "createdAt", "closedAt").limit(STATS_SAMPLE + 1).get();
  void consume("firestore.reads", Math.max(1, sample.size));
  const hours = byPriority<number[]>(() => []);
  for (const doc of sample.docs.slice(0, STATS_SAMPLE)) {
    const priority: unknown = doc.get("priority");
    const createdAt: unknown = doc.get("createdAt");
    const closedAt: unknown = doc.get("closedAt");
    if (!(REPORT_PRIORITIES as readonly unknown[]).includes(priority) || !(createdAt instanceof Timestamp) || !(closedAt instanceof Timestamp)) continue;
    hours[priority as ReportPriority].push(Math.max(0, closedAt.toMillis() - createdAt.toMillis()) / 3_600_000);
  }

  // Appeals opened in the last 90 days and decided (index appeal.status asc, appeal.openedAt asc).
  const decisions = decisionsCol();
  const since90 = Timestamp.fromDate(new Date(now.getTime() - 90 * DAY_MS));
  const overdueBefore = Timestamp.fromDate(new Date(now.getTime() - APPEAL_SLA_DAYS * DAY_MS));
  const [appealsOpen, appealsOverdue, decided90d, reversed90d, authoritiesOpen] = await Promise.all([
    count(decisions.where("appeal.status", "==", "open")),
    count(decisions.where("appeal.status", "==", "open").where("appeal.openedAt", "<", overdueBefore)),
    count(decisions.where("appeal.status", "in", ["upheld", "reversed"]).where("appeal.openedAt", ">=", since90)),
    count(decisions.where("appeal.status", "==", "reversed").where("appeal.openedAt", ">=", since90)),
    count(db().collection(COLLECTIONS.authorityRequests).where("status", "in", ["open", "answered"])),
  ]);

  return {
    generatedAt: now.toISOString(),
    open: Object.fromEntries(open) as ModerationStats["open"],
    decided30d: byPriority((priority) => ({ count: hours[priority].length, medianHours: median(hours[priority]) })),
    sampled: sample.size > STATS_SAMPLE,
    appeals: { open: appealsOpen, overdue: appealsOverdue, decided90d, reversed90d, reversalRate: decided90d > 0 ? Math.round((reversed90d / decided90d) * 1000) / 1000 : null },
    authorities: { open: authoritiesOpen },
  };
}

/** The statistics, from the 5-minute cache when there is one. */
export async function moderationStats(now = new Date()): Promise<ModerationStats> {
  const cached = isValkeyConfigured("queue");
  if (cached) {
    try {
      const value = await valkey("queue").get(CACHE_KEY);
      if (value) return JSON.parse(value) as ModerationStats;
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "decisions: stats cache unavailable");
    }
  }
  const stats = await computeModerationStats(now);
  if (cached) {
    try {
      await valkey("queue").set(CACHE_KEY, JSON.stringify(stats), "EX", STATS_CACHE_SECONDS);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "decisions: stats not cached");
    }
  }
  return stats;
}
