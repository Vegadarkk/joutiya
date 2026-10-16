import { alert } from "@/lib/alert";
import { isFirebaseConfigured } from "@/lib/firebase/admin";
import { deleteConnectionLogsPastPurge, oldestConnectionLogPastPurge } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { firstDegraded, headroom } from "@/lib/quota";

// Nightly at 03:15 UTC (§7 retention table: connection data kept 1 year, décret 2021-1362; §5
// "Purges sans TTL"): connectionLogs past purgeAt are deleted in batches. The system queue runs one
// job at a time, so this runs after retention-purge (03:00) and the R2 gauge (03:10), whose
// deletions are already in the counter, and before the backup (03:30), which then no longer
// exports them. At most CONNECTION_LOG_PURGE_BUDGET deletions a night, never past
// DELETE_QUOTA_SHARE of the Spark delete quota, and none once deletes or reads are degraded: the
// rest waits a night, and a backlog older than 3 days raises an alert. Idempotent.

export const CONNECTION_LOG_PURGE_BUDGET = 5_000;
export const CONNECTION_LOG_BATCH = 500;
/** Leaves 10 % of the 20 000 daily deletions to the hourly purges until the Pacific reset. */
export const DELETE_QUOTA_SHARE = 0.9;
export const BACKLOG_ALERT_MS = 3 * 24 * 3_600_000;

export interface ConnectionLogPurgeResult {
  deleted: number;
  /** Entries past purgeAt may remain: budget, quota headroom or a degraded quota stopped the run. */
  deferred: boolean;
}

export async function purgeConnectionLogs(now = new Date()): Promise<ConnectionLogPurgeResult> {
  const result: ConnectionLogPurgeResult = { deleted: 0, deferred: false };
  if (!isFirebaseConfigured()) {
    logger.warn("purge-connection-logs skipped: Firebase not configured");
    return result;
  }
  // Unreadable counter: the fixed budget alone (the degraded check below still applies).
  let budget = Math.min(CONNECTION_LOG_PURGE_BUDGET, (await headroom("firestore.deletes", DELETE_QUOTA_SHARE)) ?? CONNECTION_LOG_PURGE_BUDGET);
  while (true) {
    if (budget <= 0) {
      result.deferred = true;
      break;
    }
    const degraded = await firstDegraded(["firestore.deletes", "firestore.reads"]);
    if (degraded) {
      result.deferred = true;
      logger.warn({ quota: degraded }, "purge-connection-logs deferred: Firestore quota degraded");
      break;
    }
    const wanted = Math.min(CONNECTION_LOG_BATCH, budget);
    const deleted = await deleteConnectionLogsPastPurge(now, wanted);
    result.deleted += deleted;
    budget -= deleted;
    if (deleted < wanted) break;
  }
  if (result.deferred) await alertBacklog(now);
  logger.info({ ...result }, "purge-connection-logs");
  return result;
}

async function alertBacklog(now: Date): Promise<void> {
  try {
    const oldest = await oldestConnectionLogPastPurge(now);
    if (!oldest || now.getTime() - oldest.getTime() <= BACKLOG_ALERT_MS) return;
    await alert({
      severity: "P2",
      title: "Purge en retard : connectionLogs",
      body: `Des journaux de connexion attendent leur suppression depuis le ${oldest.toISOString().slice(0, 10)} (au plus ${CONNECTION_LOG_PURGE_BUDGET} suppressions par nuit, dans la limite de ${Math.round(DELETE_QUOTA_SHARE * 100)} % du quota Firestore).`,
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "purge-connection-logs: backlog check failed");
  }
}
