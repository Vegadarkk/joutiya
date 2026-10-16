import { UnrecoverableError, type Job } from "bullmq";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { boostJobSchema, expireBoost } from "@/lib/search/boosts";
import { searchEngine } from "@/lib/search/engine";
import { OUTBOX_POLL_LIMIT, indexListing, processOutbox, type IndexOutcome, type OutboxPollResult } from "@/lib/search/indexer";
import { EXPIRE_BOOST_JOB, INDEX_LISTING_JOB, OUTBOX_POLL_JOB, enqueueIndexJobs, indexJobSchema } from "@/lib/search/queue";
import { SearchUnavailableError } from "@/lib/search/types";

// Consumer of the "search" queue (design D9), concurrency 1: the engine's only writer.
//   index-listing {id, force?}  one listing from its outbox entry (forced: from the listing alone)
//   outbox-poll                 every 60 s (job scheduler): oldest entries -> index-listing jobs, lag alert
//   expire-boost {id, until}    delayed, end of an À la Une period: outbox entry, then indexed here
// Plus the onSnapshot watch on searchOutbox (lane 2), started by src/worker/index.ts.
// Spark reads (50 000 a day) bound the retry paths. Engine outage: index jobs fail fast for
// ENGINE_BACKOFF_MS without reading Firestore, and the poll reads only the oldest entry (lag, alert)
// and dispatches nothing; the outbox keeps everything. A stuck entry (an indexing bug) is dispatched
// again by the poll only after POLL_REDISPATCH_MS, or FAILED_HOLD_MS once its job failed for good.

export const OUTBOX_POLL_EVERY_MS = 60_000;
export const OUTBOX_POLL_SCHEDULER = "search-outbox-poll";
/** After an unavailable engine, index jobs fail without reading Firestore for this long; then one probes. */
export const ENGINE_BACKOFF_MS = 30_000;
/** Below the 5 min lag alert: a newer version the fast lane and the watch both missed is still on time. */
export const POLL_REDISPATCH_MS = 3 * 60_000;
export const FAILED_HOLD_MS = 30 * 60_000;

let ready: Promise<void> | undefined;
let engineDownUntil = 0;
/** Listing id -> time before which the poll does not dispatch it again (this process). */
const pollHold = new Map<string, number>();

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

/** Tests: forgets the readiness memo and any outage. */
export function resetEngineReadyForTests(): void {
  ready = undefined;
  engineDownUntil = 0;
  pollHold.clear();
}

/** The worker's failed handler: an index job that failed for good is not dispatched again for FAILED_HOLD_MS. */
export function holdFailedListing(id: string, now = Date.now()): void {
  pollHold.set(id, now + FAILED_HOLD_MS);
}

/** Runs an engine write unless an outage was seen in the last ENGINE_BACKOFF_MS; records a new one. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  if (Date.now() < engineDownUntil) throw new SearchUnavailableError("search engine unavailable: retrying later");
  try {
    await ensureEngineReady();
    return await run();
  } catch (error) {
    if (error instanceof SearchUnavailableError) engineDownUntil = Date.now() + ENGINE_BACKOFF_MS;
    throw error;
  }
}

/** The poll dispatches only to an engine that answers (an outage would turn each entry into failing jobs). */
async function engineAnswers(): Promise<boolean> {
  if (Date.now() < engineDownUntil) return false;
  try {
    return await searchEngine().healthy();
  } catch {
    return false;
  }
}

/** Poll dispatch: ids not held, each held for POLL_REDISPATCH_MS once enqueued. */
async function dispatchPolled(ids: string[]): Promise<void> {
  const now = Date.now();
  for (const [id, until] of pollHold) if (until <= now) pollHold.delete(id);
  const due = ids.filter((id) => !pollHold.has(id));
  if (due.length === 0) return;
  await enqueueIndexJobs(due);
  for (const id of due) pollHold.set(id, now + POLL_REDISPATCH_MS);
}

/** 60 s poll: with the engine down, one read for the lag and nothing dispatched. */
async function poll(): Promise<OutboxPollResult> {
  if (await engineAnswers()) return processOutbox({ limit: OUTBOX_POLL_LIMIT, dispatch: dispatchPolled });
  logger.warn("search engine unavailable: outbox entries left for a later poll");
  return processOutbox({ limit: 1, dispatch: async () => undefined });
}

export async function processSearchJob(job: Pick<Job, "name" | "data">): Promise<IndexOutcome | OutboxPollResult | boolean> {
  switch (job.name) {
    case INDEX_LISTING_JOB: {
      const data = indexJobSchema.safeParse(job.data);
      if (!data.success) throw new UnrecoverableError("invalid index-listing job");
      const { id, force } = data.data;
      return guarded(() => indexListing(id, { force: force === true }));
    }
    case OUTBOX_POLL_JOB:
      return poll();
    case EXPIRE_BOOST_JOB: {
      const data = boostJobSchema.safeParse(job.data);
      if (!data.success) throw new UnrecoverableError("invalid expire-boost job");
      if (!(await expireBoost(data.data.id))) return false;
      try {
        await guarded(() => indexListing(data.data.id));
      } catch (error) {
        // The entry is written: the poll indexes it once the engine is back.
        if (!(error instanceof SearchUnavailableError)) throw error;
        logger.warn({ listingId: data.data.id }, "boost expiry queued in the outbox: search engine unavailable");
      }
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
