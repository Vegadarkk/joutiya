import { Timestamp } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import { OPEN_STATUSES, reportFromSnapshot, type ReportRecord } from "@/lib/reports/repository";
import { parisTime } from "@/lib/reports/rules";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Every 10 minutes (design D12): open or in-review P0 reports past their due time (1 hour) get one
// more P0 alert, "P0 en retard {id}" (Telegram + e-mail relay), once per report (SET NX in
// valkey-queue, 30 days; in-process without Valkey). The creation alert ("Signalement P0 {id}",
// src/lib/reports/service.ts) has another title, so the 1-hour alert dedupe never swallows this
// one. Overdue P1-P3 reports raise nothing: their counts are the back-office dashboard's (stats
// API, L3). One query a run (index reports status, priority, slaDueAt): only overdue P0 reports are
// read, at most SLA_SWEEP_LIMIT. The body carries no personal data (target type, reason id, delays).

export const SLA_SWEEP_LIMIT = 50;
/** How long a late report stays marked as alerted (a P0 left open a month is in the dashboard anyway). */
export const LATE_MARKER_SECONDS = 30 * 86_400;

const TARGET_LABEL: Record<ReportRecord["target"]["type"], string> = { listing: "annonce", user: "profil", message: "message", pro: "boutique" };

export interface SlaSweepResult {
  /** Overdue P0 reports read. */
  overdue: number;
  /** Alerts sent this run (the others went out in an earlier run). */
  alerted: number;
  failed: number;
  stopped?: "quota";
}

/** The marker command this job uses (ioredis signature). */
export interface SlaValkey {
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<unknown>;
}

const alertedInProcess = new Set<string>();

/** Tests: forgets the in-process markers. */
export function resetSlaSweepMemory(): void {
  alertedInProcess.clear();
}

export const lateMarkerKey = (reportId: string) => `report:sla:late:${reportId}`;

/** True the first time for this report (NX); without Valkey, the first time in this process. Fails open: a late P0 must reach someone. */
async function firstTime(redis: SlaValkey | null, reportId: string): Promise<boolean> {
  if (redis) {
    try {
      return (await redis.set(lateMarkerKey(reportId), "1", "EX", LATE_MARKER_SECONDS, "NX")) === "OK";
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "report-sla-sweep: marker unavailable");
    }
  }
  if (alertedInProcess.has(reportId)) return false;
  alertedInProcess.add(reportId);
  return true;
}

/** Open and in-review P0 reports with slaDueAt <= now, most overdue first. */
export async function listOverdueP0(now: Date, limit = SLA_SWEEP_LIMIT): Promise<ReportRecord[]> {
  const snapshot = await db()
    .collection(COLLECTIONS.reports)
    .where("status", "in", [...OPEN_STATUSES])
    .where("priority", "==", "P0")
    .where("slaDueAt", "<=", Timestamp.fromDate(now))
    .orderBy("slaDueAt", "asc")
    .limit(limit)
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(reportFromSnapshot).filter((report): report is ReportRecord => report !== null);
}

/** "P0 en retard {id}": what, how late, whether it is hidden or assigned; no personal data. */
export function lateAlert(report: ReportRecord, now: Date): { severity: "P0"; title: string; body: string } {
  const lateMin = Math.max(0, Math.round((now.getTime() - report.slaDueAt.getTime()) / 60_000));
  const lines = [
    `Cible : ${TARGET_LABEL[report.target.type]}`,
    `Motif : ${report.reasonId}`,
    `Origine : ${report.source}`,
    `Statut : ${report.status === "in_review" ? "en cours d'examen" : "non traité"}${report.assignee ? " (assigné)" : ""}`,
    `Signal fort : ${report.strongSignal ? `oui (${report.strongSignal})` : "non"}`,
    `Contenu masqué : ${report.hidden ? "oui" : "non"}`,
    `Échéance : ${parisTime(report.slaDueAt)} (Paris), dépassée de ${lateMin} min`,
  ];
  return { severity: "P0", title: `P0 en retard ${report.id}`, body: lines.join("\n") };
}

export async function sweepReportSla(now = new Date(), deps: { valkey?: SlaValkey | null } = {}): Promise<SlaSweepResult> {
  const result: SlaSweepResult = { overdue: 0, alerted: 0, failed: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("report-sla-sweep skipped: Firebase not configured");
    return result;
  }
  if (await isDegraded("firestore.reads")) {
    logger.warn("report-sla-sweep skipped: Firestore read quota degraded");
    return { ...result, stopped: "quota" };
  }
  const redis = "valkey" in deps ? (deps.valkey ?? null) : isValkeyConfigured("queue") ? (valkey("queue") as unknown as SlaValkey) : null;
  const overdue = await listOverdueP0(now);
  result.overdue = overdue.length;
  for (const report of overdue) {
    try {
      if (!(await firstTime(redis, report.id))) continue;
      await alert(lateAlert(report, now));
      result.alerted += 1;
    } catch (error) {
      result.failed += 1;
      logger.error({ reportId: report.id, err: (error as Error).message }, "report-sla-sweep: alert failed");
    }
  }
  if (result.overdue > 0) logger.warn({ ...result }, "report-sla-sweep: overdue P0 reports");
  return result;
}
