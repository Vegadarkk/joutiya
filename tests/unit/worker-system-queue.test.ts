import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchedulerQueue } from "@/worker/system-queue";

// System queue plumbing of the worker (src/worker/system-queue.ts): schedulers synced with SCHEDULES
// on a fake queue (UTC upsert, retry policy, stale schedulers removed), and the failed handler
// (every attempt logged; Sentry and a P2 alert on the last one only).

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/observability/capture", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => false, isFirebaseConfigured: () => false, db: vi.fn(), auth: vi.fn() }));

const { alert } = await import("@/lib/alert");
const { captureServerException } = await import("@/lib/observability/capture");
const { logger } = await import("@/lib/logging/logger");
const { JOBS, SCHEDULES } = await import("@/worker/jobs");
const { RETRIED_SYSTEM_JOBS, SYSTEM_RETRY_DELAY_MS, onSystemJobFailed, syncSchedulers } = await import("@/worker/system-queue");

type Template = { name: string; opts: Record<string, unknown> };

/** Schedulers by id, like the queue's repeat set (only this queue's). */
function fakeQueue(existing: string[] = []) {
  const schedulers = new Map<string, Template>(existing.map((id) => [id, { name: id, opts: {} }]));
  const queue = {
    upsertJobScheduler: vi.fn(async (id: string, _repeat: { pattern: string; tz: string }, template: Template) => {
      schedulers.set(id, template);
    }),
    getJobSchedulers: vi.fn(async () => [...schedulers].map(([key, template]) => ({ key, name: template.name }))),
    removeJobScheduler: vi.fn(async (id: string) => schedulers.delete(id)),
  };
  return { queue, schedulers, asQueue: queue as unknown as SchedulerQueue };
}

beforeEach(() => {
  vi.mocked(alert).mockClear();
  vi.mocked(captureServerException).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});

describe("syncSchedulers", () => {
  it("upserts every schedule in UTC and removes the schedulers no longer in SCHEDULES", async () => {
    const { queue, schedulers, asQueue } = fakeQueue(["quota-report-nightly", "old-job-nightly", "renamed-hourly"]);
    expect(await syncSchedulers(asQueue, SCHEDULES)).toEqual(["old-job-nightly", "renamed-hourly"]);
    expect([...schedulers.keys()].sort()).toEqual(Object.keys(SCHEDULES).sort());
    expect(queue.removeJobScheduler.mock.calls.map(([id]) => id)).toEqual(["old-job-nightly", "renamed-hourly"]);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "retention-purge-nightly",
      { pattern: "0 3 * * *", tz: "UTC" },
      { name: "retention-purge", opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
    // Nothing stale on the next start.
    queue.removeJobScheduler.mockClear();
    expect(await syncSchedulers(asQueue, SCHEDULES)).toEqual([]);
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("retries only the listed idempotent jobs, once, 5 minutes later", async () => {
    const { schedulers, asQueue } = fakeQueue();
    await syncSchedulers(asQueue, SCHEDULES);
    for (const name of RETRIED_SYSTEM_JOBS) expect(Object.keys(JOBS)).toContain(name);
    for (const [id, schedule] of Object.entries(SCHEDULES)) {
      const retry = RETRIED_SYSTEM_JOBS.has(schedule.job) ? { attempts: 2, backoff: { type: "fixed", delay: SYSTEM_RETRY_DELAY_MS } } : {};
      expect(schedulers.get(id)).toEqual({ name: schedule.job, opts: { removeOnComplete: 100, removeOnFail: 500, ...retry } });
    }
    for (const name of ["retention-purge", "purge-connection-logs", "backup-firestore", "purge-quarantine", "saved-search-alerts"]) expect(RETRIED_SYSTEM_JOBS.has(name)).toBe(false);
  });

  it("a failing cleanup is logged and the worker still starts", async () => {
    const { queue, asQueue } = fakeQueue();
    queue.getJobSchedulers.mockRejectedValueOnce(new Error("legacy repeatable key"));
    expect(await syncSchedulers(asQueue, SCHEDULES)).toEqual([]);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(Object.keys(SCHEDULES).length);
    expect(logger.warn).toHaveBeenCalledWith({ err: "legacy repeatable key" }, "stale job schedulers not removed");
  });
});

describe("onSystemJobFailed", () => {
  const error = new Error("9 FAILED_PRECONDITION: The query requires an index");

  it("alerts and reports the last attempt only, naming the job", async () => {
    await onSystemJobFailed({ name: "expire-listings", attemptsMade: 1, opts: { attempts: 2 } }, error, "system");
    expect(logger.error).toHaveBeenCalledOnce();
    expect(captureServerException).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();

    await onSystemJobFailed({ name: "expire-listings", attemptsMade: 2, opts: { attempts: 2 } }, error, "system");
    expect(captureServerException).toHaveBeenCalledExactlyOnceWith(error, { queue: "system", job: "expire-listings" });
    expect(alert).toHaveBeenCalledExactlyOnceWith({
      severity: "P2",
      title: "Tâche système en échec : expire-listings",
      body: expect.stringContaining("Error: 9 FAILED_PRECONDITION: The query requires an index"),
    });
  });

  it("one attempt by default; an unknown job (stale scheduler) or a lost job alerts too", async () => {
    await onSystemJobFailed({ name: "retention-purge", attemptsMade: 1, opts: {} }, error, "system");
    await onSystemJobFailed(undefined, new Error("x".repeat(500)), "system");
    expect(vi.mocked(alert).mock.calls.map(([event]) => event.title)).toEqual(["Tâche système en échec : retention-purge", "Tâche système en échec : inconnue"]);
    // The body stays short: the error message is cut at 200 characters.
    expect(vi.mocked(alert).mock.calls[1]?.[0].body.length).toBeLessThan(300);
  });
});
