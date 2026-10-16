import type { Job } from "bullmq";
import { backupFirestore } from "./backup-firestore";
import { expireListings } from "./expire-listings";
import { sendExpiryReminders } from "./listing-expiry-reminders";
import { purgeConnectionLogs } from "./purge-connection-logs";
import { purgeQuarantine } from "./purge-quarantine";
import { purgeUnactivated } from "./purge-unactivated";
import { quotaReport } from "./quota-report";
import { r2StorageGauge } from "./r2-storage-gauge";
import { retentionPurge } from "./retention-purge";

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
  "purge-connection-logs": () => purgeConnectionLogs(),
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
  // 03:00 UTC: documents and objects past purgeAt (listings, uploads, contentOps, revealLogs).
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
} as const;
