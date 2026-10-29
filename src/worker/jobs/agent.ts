import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { AGENT_CONCURRENCY, AGENT_QUEUE, RENTAL_CHECK_JOB, agentJobSchema, rentalCheckJobSchema } from "@/lib/ai/queue";
import { runAgentTask, type AgentRunResult } from "@/lib/ai/run";
import { runRentalCheck, type RentalCheckRunResult } from "@/lib/pro/rental-check";
import { logger } from "@/lib/logging/logger";
import { captureServerException } from "@/lib/observability/capture";

// Queue "agent" (design D19): one task at a time (screening, triage, appeal review). BullMQ
// retries Claude's transient failures (3 attempts, exponential backoff); the last attempt falls
// back to the free providers instead of failing. A malformed payload never retries. The licence
// check of a car rental agency (decision 5) rides the same queue under its own job name.

export { AGENT_CONCURRENCY, AGENT_QUEUE };

export async function processAgentJob(job: Job): Promise<AgentRunResult | RentalCheckRunResult> {
  const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (job.name === RENTAL_CHECK_JOB) {
    const check = rentalCheckJobSchema.safeParse(job.data);
    if (!check.success) throw new UnrecoverableError(`invalid rental check job ${job.id ?? ""}`);
    return runRentalCheck(check.data, { final });
  }
  const data = agentJobSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError(`invalid agent job ${job.id ?? ""}`);
  return runAgentTask(data.data, { final });
}

/** The agent's consumer on the worker's connection (src/worker/index.ts). */
export function createAgentWorker(connection: Redis): Worker {
  const worker = new Worker(AGENT_QUEUE, (job) => processAgentJob(job), { connection, concurrency: AGENT_CONCURRENCY });
  worker.on("failed", (job, error) => {
    logger.error({ queue: AGENT_QUEUE, job: job?.name, attempt: job?.attemptsMade, err: error.message }, "agent job failed");
    const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
    if (final) captureServerException(error, { queue: AGENT_QUEUE, job: job?.name });
  });
  return worker;
}
