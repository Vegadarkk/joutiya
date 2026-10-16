import { UnrecoverableError, type Job } from "bullmq";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { boostJobSchema, expireBoost } from "@/lib/search/boosts";
import { searchEngine } from "@/lib/search/engine";
import { indexListing, processOutbox, type IndexOutcome, type OutboxPollResult } from "@/lib/search/indexer";
import { EXPIRE_BOOST_JOB, INDEX_LISTING_JOB, OUTBOX_POLL_JOB, enqueueIndexJobs, indexJobSchema } from "@/lib/search/queue";

// Consumer of the "search" queue (design D9), concurrency 1: the engine's only writer.
//   index-listing {id, force?}  one listing from its outbox entry (forced: from the listing alone)
//   outbox-poll                 every 60 s (job scheduler): oldest entries -> index-listing jobs, lag alert
//   expire-boost {id, until}    delayed, end of an À la Une period: outbox entry, then indexed here
// Plus the onSnapshot watch on searchOutbox (lane 2), started by src/worker/index.ts.

export const OUTBOX_POLL_EVERY_MS = 60_000;
export const OUTBOX_POLL_SCHEDULER = "search-outbox-poll";

let ready: Promise<void> | undefined;

/**
 * Index and settings in place before the first write (D4: applied at start when they differ):
 * Meilisearch would create a missing index with default settings on the first upsert. Memoized on
 * success; a failure is retried by the next job.
 */
export function ensureEngineReady(): Promise<void> {
  ready ??= (async () => {
    // Inside the async body: an engine that is not configured rejects instead of throwing.
    const outcome = await searchEngine().ensureReady();
    if (outcome.created || outcome.settingsUpdated) logger.info({ ...outcome }, "search index prepared");
  })().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

/** Tests: forgets the readiness memo. */
export function resetEngineReadyForTests(): void {
  ready = undefined;
}

export async function processSearchJob(job: Pick<Job, "name" | "data">): Promise<IndexOutcome | OutboxPollResult | boolean> {
  switch (job.name) {
    case INDEX_LISTING_JOB: {
      const data = indexJobSchema.safeParse(job.data);
      if (!data.success) throw new UnrecoverableError("invalid index-listing job");
      await ensureEngineReady();
      return indexListing(data.data.id, { force: data.data.force === true });
    }
    case OUTBOX_POLL_JOB:
      return processOutbox({ dispatch: (ids) => enqueueIndexJobs(ids) });
    case EXPIRE_BOOST_JOB: {
      const data = boostJobSchema.safeParse(job.data);
      if (!data.success) throw new UnrecoverableError("invalid expire-boost job");
      if (!(await expireBoost(data.data.id))) return false;
      await ensureEngineReady();
      await indexListing(data.data.id);
      return true;
    }
    default:
      throw new UnrecoverableError(`unknown search job ${job.name}`);
  }
}

// ---- onSnapshot watch (D9 lane 2) -------------------------------------------------------------

/** What the watch reads of a query snapshot (firebase-admin QuerySnapshot satisfies it). */
export interface WatchSnapshot {
  docChanges(): { type: "added" | "modified" | "removed"; doc: { id: string } }[];
}

export type Subscribe = (onNext: (snapshot: WatchSnapshot) => void, onError: (error: Error) => void) => () => void;

export interface OutboxWatchOptions {
  /** Hands the ids of added or changed entries to the queue. */
  dispatch: (ids: string[]) => Promise<void>;
  subscribe?: Subscribe;
  /** Entries watched (oldest first): bounds the reads of a (re)start on a large backlog. */
  limit?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface OutboxWatch {
  stop(): void;
}

export const WATCH_LIMIT = 500;

function firestoreSubscribe(limit: number): Subscribe {
  return (onNext, onError) => db().collection(COLLECTIONS.searchOutbox).orderBy("enqueuedAt", "asc").limit(limit).onSnapshot(onNext, onError);
}

/**
 * Listens to searchOutbox and enqueues every added or changed entry. Firestore bills a read per
 * delivered document (and at least one for the first snapshot), counted with `consume`. On error
 * the listener restarts after a backoff (doubling up to maxDelayMs, reset by a good snapshot);
 * meanwhile the fast lane and the 60 s poll keep indexing.
 */
export function watchSearchOutbox(options: OutboxWatchOptions): OutboxWatch {
  const subscribe = options.subscribe ?? firestoreSubscribe(options.limit ?? WATCH_LIMIT);
  const minDelay = options.minDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 5 * 60_000;
  let delay = minDelay;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const start = () => {
    if (stopped) return;
    let first = true;
    try {
      unsubscribe = subscribe(
        (snapshot) => {
          const ids = snapshot
            .docChanges()
            .filter((change) => change.type !== "removed")
            .map((change) => change.doc.id);
          if (first || ids.length > 0) void consume("firestore.reads", Math.max(first ? 1 : 0, ids.length));
          first = false;
          delay = minDelay;
          if (ids.length > 0) {
            options.dispatch(ids).catch((error: unknown) => logger.warn({ count: ids.length, err: (error as Error).message }, "search outbox watch: enqueue failed (the poll takes it)"));
          }
        },
        (error) => restart(error),
      );
    } catch (error) {
      restart(error as Error);
    }
  };

  const restart = (error: Error) => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (stopped) return;
    logger.warn({ err: error.message, retryInMs: delay }, "search outbox watch stopped: restarting");
    timer = setTimeout(start, delay);
    delay = Math.min(delay * 2, maxDelay);
  };

  start();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
