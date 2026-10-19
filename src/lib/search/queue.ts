import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { isListingId, LISTING_ID_PATTERN } from "@/lib/listings/ids";
import { logger } from "@/lib/logging/logger";
import { clientOptions } from "@/lib/valkey/clients";
import { z } from "@/lib/zod";

// Queue "search" on valkey-queue (design D9). Producers: the web's fast lane after each commit
// that wrote a searchOutbox entry (`notifySearchIndex`), the worker's outbox watch and 60 s poll,
// the nightly reconciliation and sweeps, the reindex catch-up. One consumer: the worker's search
// worker at concurrency 1 (src/worker/jobs/search.ts), the engine's only writer.
// Without QUEUE_REDIS_URL (local dev, API tests, e2e) the listing is indexed inline instead,
// one at a time in this process.

export const SEARCH_QUEUE = "search";
export const INDEX_LISTING_JOB = "index-listing";
export const OUTBOX_POLL_JOB = "outbox-poll";
export const EXPIRE_BOOST_JOB = "expire-boost";

/** D9: the fast lane never holds a request longer than this. */
export const NOTIFY_TIMEOUT_MS = 1_000;
/** Worker-side producers (poll, reconciliation, sweeps, scripts). */
export const ENQUEUE_TIMEOUT_MS = 5_000;
/** One addBulk call at most. */
const BULK_MAX = 500;

// A job id is kept while the job waits, runs or retries: a second add for the same listing in
// that time is ignored, the running pass re-reads the outbox anyway. Failed jobs are removed at
// once so they never block the next add; the outbox entry stays for the poll.
export const SEARCH_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export const indexJobSchema = z.object({ id: z.string().regex(LISTING_ID_PATTERN), force: z.literal(true).optional() }).strict();
export type IndexJobData = z.infer<typeof indexJobSchema>;

/** `idx-<id>` (outbox-driven) or `rec-<id>` (forced: reconciliation, catch-up), so neither swallows the other. */
export function indexJobId(id: string, force = false): string {
  return `${force ? "rec" : "idx"}-${id}`;
}

export function isSearchQueueEnabled(env: { QUEUE_REDIS_URL?: string } = serverEnv()): boolean {
  return Boolean(env.QUEUE_REDIS_URL);
}

let queue: Queue | undefined;
let connection: Redis | undefined;

/** Producer singleton (its own connection, like the media and mail queues). */
export function searchQueue(): Queue {
  if (queue) return queue;
  const url = serverEnv().QUEUE_REDIS_URL;
  if (!url) throw new Error("QUEUE_REDIS_URL is not set: the search queue is disabled");
  connection = new Redis(url, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  queue = new Queue(SEARCH_QUEUE, { connection });
  return queue;
}

/** Races `promise` against a timer; an add that lands later is harmless (idempotent job ids). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function validIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => isListingId(id));
}

/** Adds `index-listing` jobs. Throws when Valkey refuses or does not answer in time. */
export async function enqueueIndexJobs(ids: readonly string[], options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const unique = validIds(ids);
  const force = options.force === true;
  for (let start = 0; start < unique.length; start += BULK_MAX) {
    const jobs = unique.slice(start, start + BULK_MAX).map((id) => {
      const data: IndexJobData = force ? { id, force: true } : { id };
      return { name: INDEX_LISTING_JOB, data, opts: { ...SEARCH_JOB_OPTIONS, jobId: indexJobId(id, force) } };
    });
    await withTimeout(searchQueue().addBulk(jobs), options.timeoutMs ?? ENQUEUE_TIMEOUT_MS, "search jobs not enqueued in time");
  }
}

let inlineChain: Promise<void> = Promise.resolve();

/** Inline indexing, serialized in this process (single writer without the worker). Never throws. */
async function indexInline(ids: readonly string[], force: boolean): Promise<void> {
  const run = async () => {
    const { indexListing } = await import("./indexer");
    for (const id of ids) {
      try {
        await indexListing(id, { force });
      } catch (error) {
        logger.warn({ listingId: id, err: (error as Error).message }, "inline search indexing failed");
      }
    }
  };
  const next = inlineChain.then(run, run);
  inlineChain = next.catch(() => undefined);
  await next;
}

/**
 * Worker-side producers (poll, watch, reconciliation, sweeps, scripts): queue jobs, or index
 * inline without Valkey (tests). Throws when the queue refuses the jobs.
 */
export async function enqueueIndex(ids: readonly string[], options: { force?: boolean } = {}): Promise<void> {
  const unique = validIds(ids);
  if (unique.length === 0) return;
  if (isSearchQueueEnabled()) await enqueueIndexJobs(unique, options);
  else await indexInline(unique, options.force === true);
}

/**
 * Fast lane (D9 lane 1), called by the web after a commit that wrote searchOutbox entries for
 * `ids`. Best effort: never throws and never holds the request more than NOTIFY_TIMEOUT_MS with
 * the queue; the worker's outbox watch and poll index anything missed.
 */
export async function notifySearchIndex(ids: readonly string[]): Promise<void> {
  const unique = validIds(ids);
  if (unique.length === 0) return;
  try {
    if (isSearchQueueEnabled()) await enqueueIndexJobs(unique, { timeoutMs: NOTIFY_TIMEOUT_MS });
    else await indexInline(unique, false);
  } catch (error) {
    logger.warn({ count: unique.length, err: (error as Error).message }, "search fast lane missed: the outbox poll will index it");
  }
}

/** Tests and shutdown: closes the producer and its connection. */
export async function closeSearchQueue(): Promise<void> {
  const current = queue;
  const client = connection;
  queue = undefined;
  connection = undefined;
  await current?.close();
  await client?.quit().catch(() => undefined);
}
