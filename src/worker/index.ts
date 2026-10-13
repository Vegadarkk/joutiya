// BullMQ worker (§4) on valkey-queue. Receives no connection. Phase 1 jobs: heartbeat and the
// nightly quota report; later phases register their jobs in ./jobs.

import { writeFile } from "node:fs/promises";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL } from "@/lib/health";
import { logger } from "@/lib/logging/logger";
import { runStartupChecks } from "@/lib/startup/checks";
import { clientOptions } from "@/lib/valkey/clients";
import { JOBS, SYSTEM_QUEUE, SCHEDULES } from "./jobs";

/** Touched after each successful heartbeat; the container healthcheck reads its age. */
const HEARTBEAT_FILE = "/tmp/joutiya-worker-heartbeat";

async function main(): Promise<void> {
  await runStartupChecks("worker");
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

  const worker = new Worker(
    SYSTEM_QUEUE,
    async (job) => {
      const handler = JOBS[job.name as keyof typeof JOBS];
      if (!handler) throw new Error(`unknown job ${job.name}`);
      await handler(job);
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, error) => logger.error({ job: job?.name, err: error.message }, "job failed"));

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
    await worker.close();
    await queue.close();
    await connection.quit();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  logger.info({ queue: SYSTEM_QUEUE }, "worker started");
}

main().catch((error: unknown) => {
  logger.fatal({ err: (error as Error).message }, "worker crashed");
  process.exit(1);
});
