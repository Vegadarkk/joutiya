import type { Job } from "bullmq";
import { backupFirestore } from "./backup-firestore";
import { expireListings } from "./expire-listings";
import { liftSuspensions } from "./lift-suspensions";
import { sendExpiryReminders } from "./listing-expiry-reminders";
import { proEffectsSync } from "./pro-effects-sync";
import { purgeConnectionLogs } from "./purge-connection-logs";
import { purgeQuarantine } from "./purge-quarantine";
import { purgeUnactivated } from "./purge-unactivated";
import { quotaReport } from "./quota-report";
import { r2StorageGauge } from "./r2-storage-gauge";
import { retentionPurge } from "./retention-purge";
import { reconcileSearch } from "./reconcile-search";
import { sweepExpiredBoosts } from "./expire-boosts";
import { sendSavedSearchAlerts } from "./saved-search-alerts";
import { exportAuditLogs } from "./audit-export";
import { sendMessageDigests } from "./message-digest";
import { sweepReportSla } from "./report-sla-sweep";

// Phase 5 (design D19): queue "agent", its own consumer at concurrency 1 (createAgentWorker).
export { AGENT_CONCURRENCY, AGENT_QUEUE, createAgentWorker, processAgentJob } from "./agent";

export const SYSTEM_QUEUE = "system";

export const JOBS: Record<string, (job: Job) => Promise<unknown>> = {
  "quota-report": quotaReport,
  "purge-unactivated": () => purgeUnactivated(),
  "purge-quarantine": () => purgeQuarantine(),
  "r2-storage-gauge": () => r2StorageGauge(),
  "backup-firestore": () => backupFirestore(),
  "expire-listings": () => expireListings(),
  "listing-expiry-reminders": () => sendExpiryReminders(),
  "retention-purge": () => retentionPurge(),
  "reconcile-search": () => reconcileSearch(),
  "expire-boosts": () => sweepExpiredBoosts(),
  "saved-search-alerts": () => sendSavedSearchAlerts(),
  "purge-connection-logs": () => purgeConnectionLogs(),
  "pro-effects-sync": () => proEffectsSync(),
  "lift-suspensions": () => liftSuspensions(),
  "message-digest": () => sendMessageDigests(),
  "report-sla-sweep": () => sweepReportSla(),
  "audit-export": () => exportAuditLogs(),
};

/** Repeatable jobs (UTC cron patterns), upserted at every start. */
export const SCHEDULES = {
  // 08:15 UTC: both the UTC day and the Pacific day (Firestore resets) are closed.
  "quota-report-nightly": { pattern: "15 8 * * *", job: "quota-report" },
  // Every hour at :05 (§6: pending accounts are deleted 24 h after sign-up).
  "purge-unactivated-hourly": { pattern: "5 * * * *", job: "purge-unactivated" },
  // 02:30 UTC (D16): published listings past expiresAt -> expired; 02:40: reminder 3 days before.
  "expire-listings-nightly": { pattern: "30 2 * * *", job: "expire-listings" },
  "listing-expiry-reminders-nightly": { pattern: "40 2 * * *", job: "listing-expiry-reminders" },
  // 03:00 UTC: documents and objects past purgeAt (listings, uploads, contentOps, revealLogs; phase 5
  // D22: conversations, reports, decisions, authority requests, AI proposals, auditLogs, userBlocks).
  "retention-purge-nightly": { pattern: "0 3 * * *", job: "retention-purge" },
  // Every hour at :20 (§6: unprocessed uploads purged after 24 h).
  "purge-quarantine-hourly": { pattern: "20 * * * *", job: "purge-quarantine" },
  // 03:10 UTC: media bucket recount for the R2 storage gauge (D15).
  "r2-storage-gauge-nightly": { pattern: "10 3 * * *", job: "r2-storage-gauge" },
  // 03:15 UTC: connectionLogs past purgeAt (1 year). The system queue runs one job at a time: after
  // retention-purge (its deletions are then in the counter), before the backup (03:30).
  "purge-connection-logs-nightly": { pattern: "15 3 * * *", job: "purge-connection-logs" },
  // 03:30 UTC (D17): encrypted Firestore backup, after retention-purge (03:00) and the R2 gauge (03:10).
  "backup-firestore-nightly": { pattern: "30 3 * * *", job: "backup-firestore" },
  // Phase 7. 03:50 UTC: Pro claims and listings retag a verification left pending (effects.ts).
  "pro-effects-sync-nightly": { pattern: "50 3 * * *", job: "pro-effects-sync" },
  // Phase 4. 04:05 UTC: À la Une ended since the last sweep -> searchOutbox (safety net of the
  // delayed expire-boost jobs). 04:20 UTC: Firestore vs search index, after the backup's reads.
  "expire-boosts-nightly": { pattern: "5 4 * * *", job: "expire-boosts" },
  "reconcile-search-nightly": { pattern: "20 4 * * *", job: "reconcile-search" },
  // 07:00 UTC (08:00 in Morocco): one digest e-mail per user for the saved searches with alerts.
  "saved-search-alerts-daily": { pattern: "0 7 * * *", job: "saved-search-alerts" },
  // Phase 5 (D14). Every hour at :35: suspensions past `until` lifted (claim, status, listings).
  "lift-suspensions-hourly": { pattern: "35 * * * *", job: "lift-suspensions" },
  // Phase 5 (D21). Every 10 minutes from :01: grouped new-messages mails due (30 min after the first unread).
  "message-digest-10min": { pattern: "1-59/10 * * * *", job: "message-digest" },
  // Phase 5 (D12). Every 10 minutes from :07: open P0 reports past their 1-hour target -> one more P0 alert.
  "report-sla-sweep-10min": { pattern: "7-59/10 * * * *", job: "report-sla-sweep" },
  // Phase 5 (D23). 03:22 UTC: yesterday's auditLogs -> age-encrypted NDJSON in the private bucket, before the backup (03:30).
  "audit-export-nightly": { pattern: "22 3 * * *", job: "audit-export" },
} as const;
