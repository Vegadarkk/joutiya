// BullMQ worker (§4) on valkey-queue. Receives no connection. Queues: "system" (heartbeat, nightly
// quota report, hourly purge of unactivated accounts), "mail" (deliveries with retries), "media"
// (photo pipeline, one upload at a time, D12), "search" (phase 4 D9: the search index's only
// writer, one job at a time, fed by the web's fast lane, the searchOutbox watch and a 60 s poll)
// and "agent" (phase 5 D19: the moderation agent, one task at a time, fed by the listings publish
// and renew paths, the reports service and the appeals service).

import { writeFile } from "node:fs/promises";
import { DelayedError, Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { closeAgentQueue } from "@/lib/ai/queue";
import { serverEnv } from "@/lib/env";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL } from "@/lib/health";
import { logger } from "@/lib/logging/logger";
import { captureServerException } from "@/lib/observability/capture";
import { flushObservability, initServerObservability } from "@/lib/observability/sentry-server";
import { deliverMail, MailDeferredError } from "@/lib/mail/deliver";
import { isTemplateMail } from "@/lib/mail/render";
import { closeMailQueue, MAIL_QUEUE } from "@/lib/mail/send";
import { checkModelsAtStartup, resetImageClassifier } from "@/lib/media/classify";
import { closeMediaQueue, MEDIA_CONCURRENCY, MEDIA_QUEUE } from "@/lib/media/queue";
import { isFirebaseConfigured } from "@/lib/firebase/admin";
import { SearchUnavailableError } from "@/lib/search/types";
import { closeSearchQueue, enqueueIndexJobs, indexJobSchema, OUTBOX_POLL_JOB, SEARCH_QUEUE } from "@/lib/search/queue";
import { setGauge } from "@/lib/quota";
import { usedMemoryBytes } from "@/lib/quota/valkey-memory";
import { runStartupChecks } from "@/lib/startup/checks";
import { clientOptions } from "@/lib/valkey/clients";
import { AGENT_QUEUE, createAgentWorker, JOBS, SYSTEM_QUEUE, SCHEDULES } from "./jobs";
import { onMediaJobFailed, processMediaJob } from "./jobs/media";
import { ensureEngineReady, holdFailedListing, OUTBOX_POLL_EVERY_MS, OUTBOX_POLL_SCHEDULER, processSearchJob, watchSearchOutbox } from "./jobs/search";
import { onSystemJobFailed, syncSchedulers } from "./system-queue";

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
  // Missing ONNX models alert now rather than at the first photo (the classifier still fails closed).
  await checkModelsAtStartup(env);
  // BullMQ requires maxRetriesPerRequest: null on worker connections.
  const connection = new Redis(env.QUEUE_REDIS_URL, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  const queue = new Queue(SYSTEM_QUEUE, { connection });

  await syncSchedulers(queue, SCHEDULES);

  const systemWorker = new Worker(
    SYSTEM_QUEUE,
    async (job) => {
      const handler = JOBS[job.name as keyof typeof JOBS];
      if (!handler) throw new Error(`unknown job ${job.name}`);
      await handler(job);
    },
    { connection, concurrency: 1 },
  );
  systemWorker.on("failed", (job, error) => void onSystemJobFailed(job, error, SYSTEM_QUEUE));

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

  // Search index (D9): concurrency 1 keeps a single engine writer; the poll is a job of the same
  // queue. A job's final failure reaches Sentry unless the engine is just down (the lag alert
  // reports that); the outbox entry stays for the poll, which waits before dispatching it again.
  const searchQueue = new Queue(SEARCH_QUEUE, { connection });
  await searchQueue.upsertJobScheduler(OUTBOX_POLL_SCHEDULER, { every: OUTBOX_POLL_EVERY_MS }, { name: OUTBOX_POLL_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } });
  const searchWorker = new Worker(SEARCH_QUEUE, (job) => processSearchJob(job), { connection, concurrency: 1 });
  searchWorker.on("failed", (job, error) => {
    logger.error({ queue: SEARCH_QUEUE, job: job?.name, attempt: job?.attemptsMade, err: error.message }, "search job failed");
    const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
    if (!final || error instanceof SearchUnavailableError) return;
    captureServerException(error, { queue: SEARCH_QUEUE, job: job?.name });
    const data = indexJobSchema.safeParse(job?.data);
    if (data.success) holdFailedListing(data.data.id);
  });
  void ensureEngineReady().catch((error: unknown) => logger.warn({ err: (error as Error).message }, "search index not prepared yet: the first search job retries"));
  const outboxWatch = isFirebaseConfigured() ? watchSearchOutbox({ dispatch: (ids) => enqueueIndexJobs(ids) }) : null;

  // Moderation agent (phase 5 D19): one task at a time; its "failed" listener (log, Sentry on the
  // final attempt or an unrecoverable payload) lives with the processor in jobs/agent.ts.
  const agentWorker = createAgentWorker(connection);

  const beat = async () => {
    try {
      await connection.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), "EX", WORKER_HEARTBEAT_TTL);
      await writeFile(HEARTBEAT_FILE, "").catch(() => undefined);
      // valkey-queue never evicts: the gauge alerts before a full memory blinds every quota guard.
      const used = usedMemoryBytes(await connection.info("memory"));
      if (used !== null) await setGauge("valkey.queueMemory", used);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "heartbeat failed");
    }
  };
  await beat();
  const heartbeat = setInterval(beat, 30_000);

  const stop = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    clearInterval(heartbeat);
    outboxWatch?.stop();
    await Promise.allSettled([systemWorker.close(), mailWorker.close(), mediaWorker.close(), searchWorker.close(), agentWorker.close()]);
    await Promise.allSettled([queue.close(), searchQueue.close(), closeMailQueue(), closeMediaQueue(), closeSearchQueue(), closeAgentQueue(), resetImageClassifier()]);
    await connection.quit().catch(() => undefined);
    await flushObservability(2_000);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  logger.info({ queues: [SYSTEM_QUEUE, MAIL_QUEUE, MEDIA_QUEUE, SEARCH_QUEUE, AGENT_QUEUE] }, "worker started");
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: (error as Error).message }, "worker crashed");
  captureServerException(error, { phase: "startup" });
  await flushObservability(2_000);
  process.exit(1);
});
