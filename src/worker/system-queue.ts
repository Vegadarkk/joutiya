import type { Job, Queue } from "bullmq";
import { alert } from "@/lib/alert";
import { logger } from "@/lib/logging/logger";
import { captureServerException } from "@/lib/observability/capture";

// System queue plumbing of the worker (index.ts), apart so it is testable without starting it: the
// schedulers of SCHEDULES with their retry policy, and the report of a failed job.

/**
 * Retried once, 5 minutes later: idempotent jobs without a per-run budget a retry would reset. One
 * attempt for the others: hourly jobs (the next run retries), the purges with a nightly delete
 * budget (retention-purge, purge-connection-logs), the backup (heavy, alerts itself, its cursors do
 * not move), reconcile-search (up to 8 000 reads) and saved-search-alerts (per-run mail cap).
 */
export const RETRIED_SYSTEM_JOBS: ReadonlySet<string> = new Set(["quota-report", "expire-listings", "listing-expiry-reminders", "r2-storage-gauge", "expire-boosts", "billing-thresholds"]);
export const SYSTEM_RETRY_DELAY_MS = 5 * 60_000;

export type Schedules = Readonly<Record<string, { readonly pattern: string; readonly job: string }>>;
export type SchedulerQueue = Pick<Queue, "upsertJobScheduler" | "getJobSchedulers" | "removeJobScheduler">;

/**
 * Upserts every scheduler of `schedules` (UTC cron), then removes the queue's others: a renamed or
 * deleted entry would fire forever and fail on `unknown job`. Only this queue's schedulers are
 * listed (the search queue's outbox poll is not). A failed cleanup is logged and the worker starts.
 * Returns the removed ids.
 */
export async function syncSchedulers(queue: SchedulerQueue, schedules: Schedules): Promise<string[]> {
  for (const [id, schedule] of Object.entries(schedules)) {
    const retry = RETRIED_SYSTEM_JOBS.has(schedule.job) ? { attempts: 2, backoff: { type: "fixed", delay: SYSTEM_RETRY_DELAY_MS } } : {};
    await queue.upsertJobScheduler(id, { pattern: schedule.pattern, tz: "UTC" }, { name: schedule.job, opts: { removeOnComplete: 100, removeOnFail: 500, ...retry } });
  }
  const keep = new Set(Object.keys(schedules));
  const removed: string[] = [];
  try {
    for (const scheduler of await queue.getJobSchedulers()) {
      if (keep.has(scheduler.key)) continue;
      await queue.removeJobScheduler(scheduler.key);
      removed.push(scheduler.key);
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "stale job schedulers not removed");
  }
  if (removed.length > 0) logger.info({ removed }, "stale job schedulers removed");
  return removed;
}

/**
 * "failed" handler of the system queue: every attempt is logged; the last one reaches Sentry and,
 * Sentry being optional, the alert channels (P2, one title per job: the hour's dedupe bounds an
 * hourly job failing every run). An earlier attempt is retried by BullMQ.
 */
export async function onSystemJobFailed(job: Pick<Job, "name" | "attemptsMade" | "opts"> | undefined, error: Error, queue: string): Promise<void> {
  logger.error({ queue, job: job?.name, attempt: job?.attemptsMade, err: error.message }, "job failed");
  if (job && job.attemptsMade < (job.opts.attempts ?? 1)) return;
  captureServerException(error, { queue, job: job?.name });
  await alert({
    severity: "P2",
    title: `Tâche système en échec : ${job?.name ?? "inconnue"}`,
    body: `${error.name}: ${error.message.slice(0, 200)}. La tâche repart à sa prochaine échéance.`,
  });
}
