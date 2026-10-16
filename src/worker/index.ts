// BullMQ worker (§4) on valkey-queue. Receives no connection. Queues: "system" (heartbeat, nightly
// quota report, hourly purge of unactivated accounts), "mail" (deliveries with retries) and
// "media" (photo pipeline, one upload at a time, D12).

import { writeFile } from "node:fs/promises";
import { DelayedError, Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL } from "@/lib/health";
import { logger } from "@/lib/logging/logger";
import { captureServerException } from "@/lib/observability/capture";
import { flushObservability, initServerObservability } from "@/lib/observability/sentry-server";
import { deliverMail, MailDeferredError } from "@/lib/mail/deliver";
import { isTemplateMail } from "@/lib/mail/render";
import { closeMailQueue, MAIL_QUEUE } from "@/lib/mail/send";
import { resetImageClassifier } from "@/lib/media/classify";
import { closeMediaQueue, MEDIA_CONCURRENCY, MEDIA_QUEUE } from "@/lib/media/queue";
import { runStartupChecks } from "@/lib/startup/checks";
import { clientOptions } from "@/lib/valkey/clients";
import { JOBS, SYSTEM_QUEUE, SCHEDULES } from "./jobs";
import { onMediaJobFailed, processMediaJob } from "./jobs/media";

/** Touched after each successful heartbeat; the container healthcheck reads its age. */
const HEARTBEAT_FILE = "/tmp/joutiya-worker-heartbeat";

async function main(): Promise<void> {
  await runStartupChecks("worker");
  initServerObservability("worker");
  const env = serverEnv();
  if (!env.QUEUE_REDIS_URL) {
    logger.fatal("QUEUE_REDIS_URL is not set: the worker has nothing to process");
    process.exit(1);
  }
  // BullMQ requires maxRetriesPerRequest: null on worker connections.
  const connection = new Redis(env.QUEUE_REDIS_URL, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  const queue = new Queue(SYSTEM_QUEUE, { connection });

  for (const [id, schedule] of Object.entries(SCHEDULES)) {
    await queue.upsertJobScheduler(id, { pattern: schedule.pattern, tz: "UTC" }, { name: schedule.job, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }

  const systemWorker = new Worker(
    SYSTEM_QUEUE,
    async (job) => {
      const handler = JOBS[job.name as keyof typeof JOBS];
      if (!handler) throw new Error(`unknown job ${job.name}`);
      await handler(job);
    },
    { connection, concurrency: 1 },
  );
  systemWorker.on("failed", (job, error) => {
    logger.error({ queue: SYSTEM_QUEUE, job: job?.name, err: error.message }, "job failed");
    captureServerException(error, { queue: SYSTEM_QUEUE, job: job?.name });
  });

  const mailWorker = new Worker(
    MAIL_QUEUE,
    async (job, token) => {
      // Job payloads are ours, but a malformed one must not burn five retries.
      if (!isTemplateMail(job.data)) throw new UnrecoverableError(`invalid mail job ${job.id ?? ""}`);
      try {
        await deliverMail(job.data);
      } catch (error) {
        if (!(error instanceof MailDeferredError)) throw error;
        // Quotas exhausted or provider unavailable: the job waits for the reset instead of burning
        // its quick retries (BullMQ: moveToDelayed with the lock token, then DelayedError, which
        // the worker swallows without a "failed" event).
        logger.warn({ queue: MAIL_QUEUE, job: job.name, retryAt: error.retryAt.toISOString(), reason: error.message }, "mail job deferred");
        await job.moveToDelayed(error.retryAt.getTime(), token);
        throw new DelayedError();
      }
    },
    { connection, concurrency: 2 },
  );
  mailWorker.on("failed", (job, error) => {
    logger.error({ queue: MAIL_QUEUE, job: job?.name, attempt: job?.attemptsMade, err: error.message }, "mail job failed");
    // Only the final attempt reaches Sentry: BullMQ retries the earlier ones.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) captureServerException(error, { queue: MAIL_QUEUE, job: job.name });
  });

  // sharp + ONNX on one image at a time: bounded memory on the VM (§2).
  const mediaWorker = new Worker(MEDIA_QUEUE, (job) => processMediaJob(job), { connection, concurrency: MEDIA_CONCURRENCY });
  mediaWorker.on("failed", (job, error) => {
    logger.error({ queue: MEDIA_QUEUE, job: job?.name, attempt: job?.attemptsMade, err: error.message }, "media job failed");
    // The final attempt expires the upload and reaches Sentry; BullMQ retries the earlier ones.
    void onMediaJobFailed(job, error).then((final) => {
      if (final) captureServerException(error, { queue: MEDIA_QUEUE, job: job?.name });
    });
  });

  const beat = async () => {
    try {
      await connection.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), "EX", WORKER_HEARTBEAT_TTL);
      await writeFile(HEARTBEAT_FILE, "").catch(() => undefined);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "heartbeat failed");
    }
  };
  await beat();
  const heartbeat = setInterval(beat, 30_000);

  const stop = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    clearInterval(heartbeat);
    await Promise.allSettled([systemWorker.close(), mailWorker.close(), mediaWorker.close()]);
    await Promise.allSettled([queue.close(), closeMailQueue(), closeMediaQueue(), resetImageClassifier()]);
    await connection.quit().catch(() => undefined);
    await flushObservability(2_000);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  logger.info({ queues: [SYSTEM_QUEUE, MAIL_QUEUE, MEDIA_QUEUE] }, "worker started");
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: (error as Error).message }, "worker crashed");
  captureServerException(error, { phase: "startup" });
  await flushObservability(2_000);
  process.exit(1);
});
