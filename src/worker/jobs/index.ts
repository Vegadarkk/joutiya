import type { Job } from "bullmq";
import { purgeQuarantine } from "./purge-quarantine";
import { purgeUnactivated } from "./purge-unactivated";
import { quotaReport } from "./quota-report";
import { r2StorageGauge } from "./r2-storage-gauge";

export const SYSTEM_QUEUE = "system";

export const JOBS: Record<string, (job: Job) => Promise<unknown>> = {
  "quota-report": quotaReport,
  "purge-unactivated": () => purgeUnactivated(),
  "purge-quarantine": () => purgeQuarantine(),
  "r2-storage-gauge": () => r2StorageGauge(),
};

/** Repeatable jobs (UTC cron patterns), upserted at every start. */
export const SCHEDULES = {
  // 08:15 UTC: both the UTC day and the Pacific day (Firestore resets) are closed.
  "quota-report-nightly": { pattern: "15 8 * * *", job: "quota-report" },
  // Every hour at :05 (§6: pending accounts are deleted 24 h after sign-up).
  "purge-unactivated-hourly": { pattern: "5 * * * *", job: "purge-unactivated" },
  // Every hour at :20 (§6: unprocessed uploads purged after 24 h).
  "purge-quarantine-hourly": { pattern: "20 * * * *", job: "purge-quarantine" },
  // 03:10 UTC: media bucket recount for the R2 storage gauge (D15).
  "r2-storage-gauge-nightly": { pattern: "10 3 * * *", job: "r2-storage-gauge" },
} as const;
