import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { clientOptions } from "@/lib/valkey/clients";
import { z } from "@/lib/zod";

// Queue "billing" on valkey-queue (phase 7 design §6): the RevenueCat webhook records the event and
// answers 200 at once; the worker (src/worker/jobs/billing.ts, concurrency 1: one wallet writer)
// re-reads the purchase from RevenueCat and writes the order and the ledger. Without
// QUEUE_REDIS_URL (local dev, API tests) the webhook processes the event inline instead.
// Payloads hold the event id only.

export const BILLING_QUEUE = "billing";
export const BILLING_JOB = "revenuecat-event";
export const BILLING_CONCURRENCY = 1;
export const ENQUEUE_TIMEOUT_MS = 5_000;

// RevenueCat may show a purchase in its API a little after the webhook, and its API may rate
// limit: 8 attempts from 1 minute doubling (about 2 hours in all). The last failure alerts.
export const BILLING_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3_600, count: 500 },
} as const;

export const billingJobSchema = z.object({ eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
export type BillingJobData = z.infer<typeof billingJobSchema>;

export function isBillingQueueEnabled(env: { QUEUE_REDIS_URL?: string } = serverEnv()): boolean {
  return Boolean(env.QUEUE_REDIS_URL);
}

let queue: Queue | undefined;
let connection: Redis | undefined;

function billingQueue(url: string): Queue {
  if (queue) return queue;
  connection = new Redis(url, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  queue = new Queue(BILLING_QUEUE, { connection });
  return queue;
}

/** One job per event: BullMQ ignores an add whose id is still known. */
export async function enqueueBillingEvent(eventId: string): Promise<void> {
  const url = serverEnv().QUEUE_REDIS_URL;
  if (!url) throw new Error("QUEUE_REDIS_URL is not set: the billing queue is disabled");
  const data: BillingJobData = billingJobSchema.parse({ eventId });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("billing job not enqueued in time")), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([billingQueue(url).add(BILLING_JOB, data, { ...BILLING_JOB_OPTIONS, jobId: `rc-${eventId}` }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tests and shutdown: closes the producer and its connection. */
export async function closeBillingQueue(): Promise<void> {
  const current = queue;
  const client = connection;
  queue = undefined;
  connection = undefined;
  await current?.close();
  await client?.quit().catch(() => undefined);
}
