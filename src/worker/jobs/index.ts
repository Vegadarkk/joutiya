import type { Job } from "bullmq";
import { quotaReport } from "./quota-report";

export const SYSTEM_QUEUE = "system";

export const JOBS: Record<string, (job: Job) => Promise<void>> = {
  "quota-report": quotaReport,
};

/** Repeatable jobs (UTC cron patterns), upserted at every start. */
export const SCHEDULES = {
  // 08:15 UTC: both the UTC day and the Pacific day (Firestore resets) are closed.
  "quota-report-nightly": { pattern: "15 8 * * *", job: "quota-report" },
} as const;
