import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { clientOptions } from "@/lib/valkey/clients";
import { z } from "@/lib/zod";
import { AI_TASKS, TASK_TARGET, type AiTarget, type AiTask } from "./types";

// Queue "agent" on valkey-queue (design D19): the only way to run the agent. Producers: the
// listings publish path (screening), the reports service (triage), the appeals service (review).
// One consumer: the worker, concurrency 1 (src/worker/jobs/agent.ts). The agent never runs in a
// request path: without QUEUE_REDIS_URL (local dev, API tests) a task is dropped with a log line.
// Payloads hold a task and an id only: nothing personal stays in Valkey.

export const AGENT_QUEUE = "agent";
export const AGENT_JOB = "ai-task";
export const AGENT_CONCURRENCY = 1;
export const ENQUEUE_TIMEOUT_MS = 2_000;

// Three attempts with a growing delay cover Claude's 429/529 and network errors; the last attempt
// falls back to the free providers instead of failing (router `final`).
export const AGENT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3_600, count: 500 },
} as const;

const targetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const agentJobSchema = z
  .object({
    task: z.enum(AI_TASKS),
    target: z.object({ type: z.enum(["listing", "report", "decision"]), id: targetIdSchema }).strict(),
  })
  .strict()
  .refine((job) => TASK_TARGET[job.task] === job.target.type, { message: "target type does not match the task", path: ["target", "type"] });
export type AgentJobData = z.infer<typeof agentJobSchema>;

/** One waiting job per task and target: a second add while it waits is absorbed (the job reads the latest state). */
export function agentJobId(task: AiTask, target: AiTarget): string {
  return `${task}-${target.id}`;
}

let queue: Queue | undefined;
let connection: Redis | undefined;

function agentQueue(url: string): Queue {
  if (queue) return queue;
  connection = new Redis(url, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  queue = new Queue(AGENT_QUEUE, { connection });
  return queue;
}

/**
 * Queues an agent task (`enqueueAiTask("report_triage", { type: "report", id })`). Throws on an
 * invalid task/target pair; resolves `{ queued: false }` when the queue is not configured. Callers
 * that must not fail (after a commit) catch and log.
 */
export async function enqueueAiTask(task: AiTask, target: AiTarget): Promise<{ queued: boolean }> {
  const data: AgentJobData = agentJobSchema.parse({ task, target: { type: target.type, id: target.id } });
  const url = serverEnv().QUEUE_REDIS_URL;
  if (!url) {
    logger.debug({ task, target: data.target.type }, "ai: queue not configured, task dropped");
    return { queued: false };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("agent job not enqueued in time")), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([agentQueue(url).add(AGENT_JOB, data, { ...AGENT_JOB_OPTIONS, jobId: agentJobId(task, data.target) }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return { queued: true };
}

/** Tests and shutdown: closes the producer and its connection. */
export async function closeAgentQueue(): Promise<void> {
  const current = queue;
  const client = connection;
  queue = undefined;
  connection = undefined;
  await current?.close();
  await client?.quit().catch(() => undefined);
}
