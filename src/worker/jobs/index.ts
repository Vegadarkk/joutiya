import type { Job } from "bullmq";
import { purgeUnactivated } from "./purge-unactivated";
import { quotaReport } from "./quota-report";

export const SYSTEM_QUEUE = "system";

export const JOBS: Record<string, (job: Job) => Promise<unknown>> = {
  "quota-report": quotaReport,
  "purge-unactivated": () => purgeUnactivated(),
};

/** Repeatable jobs (UTC cron patterns), upserted at every start. */
export const SCHEDULES = {
  // 08:15 UTC: both the UTC day and the Pacific day (Firestore resets) are closed.
  "quota-report-nightly": { pattern: "15 8 * * *", job: "quota-report" },
  // Every hour at :05 (§6: pending accounts are deleted 24 h after sign-up).
  "purge-unactivated-hourly": { pattern: "5 * * * *", job: "purge-unactivated" },
} as const;
