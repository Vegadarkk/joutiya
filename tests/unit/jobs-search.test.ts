import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Boosts from "@/lib/search/boosts";
import type * as Queue from "@/lib/search/queue";
import { SearchUnavailableError, type SearchEngine } from "@/lib/search/types";

// The search queue's consumer (design D9): job dispatch, engine readiness before the first write
// (memoized, retried after a failure), the poll's read bounds (engine down, writes failing, every
// entry held, read quota spent) and the searchOutbox onSnapshot watch: reads counted per delivered
// entry, restart with a doubling backoff, clean stop.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const degraded = new Set<string>();
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async (id: string) => degraded.has(id)) }));
vi.mock("@/lib/firebase/admin", () => ({ db: vi.fn() }));
vi.mock("@/lib/search/indexer", () => ({ OUTBOX_POLL_LIMIT: 200, indexListing: vi.fn(async () => ({ acked: true })), processOutbox: vi.fn(async () => ({ pending: 0, lagSeconds: 0, alerted: false })) }));
vi.mock("@/lib/search/boosts", async (importOriginal) => ({ ...(await importOriginal<typeof Boosts>()), expireBoost: vi.fn(async () => true) }));
vi.mock("@/lib/search/queue", async (importOriginal) => ({ ...(await importOriginal<typeof Queue>()), enqueueIndexJobs: vi.fn(async () => undefined) }));
const ensureReady = vi.fn<() => Promise<{ created: boolean; settingsUpdated: boolean }>>(async () => ({ created: false, settingsUpdated: false }));
const healthy = vi.fn(async () => true);
const engineState = { throwOnAccess: false };
vi.mock("@/lib/search/engine", () => ({
  searchEngine: () => {
    if (engineState.throwOnAccess) throw new Error("search is not configured");
    return { ensureReady, healthy } as unknown as SearchEngine;
  },
}));

const { consume } = await import("@/lib/quota");
const { indexListing, processOutbox } = await import("@/lib/search/indexer");
const { expireBoost } = await import("@/lib/search/boosts");
const { enqueueIndexJobs } = await import("@/lib/search/queue");
const { logger } = await import("@/lib/logging/logger");
const jobs = await import("@/worker/jobs/search");

beforeEach(() => {
  jobs.resetEngineReadyForTests();
  degraded.clear();
  engineState.throwOnAccess = false;
  ensureReady.mockReset().mockResolvedValue({ created: false, settingsUpdated: false });
  healthy.mockReset().mockResolvedValue(true);
  vi.mocked(indexListing).mockClear();
  vi.mocked(processOutbox).mockClear();
  vi.mocked(expireBoost).mockReset().mockResolvedValue(true);
  vi.mocked(enqueueIndexJobs).mockClear();
  vi.mocked(consume).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processSearchJob", () => {
  it("index-listing: prepares the engine once, then indexes (forced when asked)", async () => {
    await jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } });
    await jobs.processSearchJob({ name: "index-listing", data: { id: "bcdefghj", force: true } });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(indexListing).toHaveBeenNthCalledWith(1, "abcdefgh", { force: false });
    expect(indexListing).toHaveBeenNthCalledWith(2, "bcdefghj", { force: true });
  });

  it("rejects malformed and unknown jobs without retries", async () => {
    await expect(jobs.processSearchJob({ name: "index-listing", data: { id: "../x" } })).rejects.toMatchObject({ name: "UnrecoverableError" });
    await expect(jobs.processSearchJob({ name: "expire-boost", data: { id: "abcdefgh" } })).rejects.toMatchObject({ name: "UnrecoverableError" });
    await expect(jobs.processSearchJob({ name: "something", data: {} })).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(indexListing).not.toHaveBeenCalled();
  });

  /** Runs one poll and returns the options it gave processOutbox. */
  async function poll() {
    vi.mocked(processOutbox).mockClear();
    await jobs.processSearchJob({ name: "outbox-poll", data: {} });
    return vi.mocked(processOutbox).mock.calls[0]?.[0];
  }

  it("outbox-poll hands the ids to index-listing jobs while the engine answers", async () => {
    const options = await poll();
    expect(options?.limit).toBe(200);
    await options?.dispatch?.(["abcdefgh"]);
    expect(enqueueIndexJobs).toHaveBeenCalledWith(["abcdefgh"]);
  });

  it("with the engine down the poll reads only the oldest entry and dispatches nothing", async () => {
    healthy.mockResolvedValueOnce(false);
    const options = await poll();
    expect(options?.limit).toBe(1);
    await options?.dispatch?.(["abcdefgh"]);
    expect(enqueueIndexJobs).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("the poll waits before dispatching the same entry again, longer once its job failed for good", async () => {
    vi.useFakeTimers();
    await (await poll())?.dispatch?.(["abcdefgh", "bcdefghj"]);
    await (await poll())?.dispatch?.(["abcdefgh", "bcdefghj", "cdefghjk"]);
    expect(vi.mocked(enqueueIndexJobs).mock.calls).toEqual([[["abcdefgh", "bcdefghj"]], [["cdefghjk"]]]);
    jobs.holdFailedListing("bcdefghj");
    vi.advanceTimersByTime(jobs.POLL_REDISPATCH_MS);
    await (await poll())?.dispatch?.(["abcdefgh", "bcdefghj"]);
    expect(enqueueIndexJobs).toHaveBeenLastCalledWith(["abcdefgh"]);
    vi.advanceTimersByTime(jobs.FAILED_HOLD_MS);
    await (await poll())?.dispatch?.(["bcdefghj"]);
    expect(enqueueIndexJobs).toHaveBeenLastCalledWith(["bcdefghj"]);
  });

  it("a full page of held entries makes the next polls read only the oldest one, until it changes or FAILED_HOLD_MS passes", async () => {
    vi.useFakeTimers();
    await (await poll())?.dispatch?.(["abcdefgh", "bcdefghj"]);
    // Every entry read is held (jobs failing or still running): nothing to dispatch.
    const held = await poll();
    expect(held?.limit).toBe(200);
    await held?.dispatch?.(["abcdefgh", "bcdefghj"]);
    const quiet = await poll();
    expect(quiet?.limit).toBe(1);
    await quiet?.dispatch?.(["abcdefgh"]);
    vi.advanceTimersByTime(jobs.POLL_REDISPATCH_MS);
    // Still the same oldest entry: dispatched alone once due, the rest is not read.
    const probe = await poll();
    expect(probe?.limit).toBe(1);
    await probe?.dispatch?.(["abcdefgh"]);
    expect(enqueueIndexJobs).toHaveBeenLastCalledWith(["abcdefgh"]);
    // A new oldest entry (the old one was acknowledged): a full page again.
    await (await poll())?.dispatch?.(["cdefghjk"]);
    expect(enqueueIndexJobs).toHaveBeenLastCalledWith(["cdefghjk"]);
    const full = await poll();
    expect(full?.limit).toBe(200);
    await full?.dispatch?.(["abcdefgh", "cdefghjk"]);
    expect((await poll())?.limit).toBe(1);
    vi.advanceTimersByTime(jobs.FAILED_HOLD_MS);
    expect((await poll())?.limit).toBe(200);
  });

  it("a listing failing for good again waits twice as long each time, until one of its jobs succeeds", async () => {
    vi.useFakeTimers();
    const dispatchedAfter = async (ms: number) => {
      vi.advanceTimersByTime(ms);
      vi.mocked(enqueueIndexJobs).mockClear();
      await (await poll())?.dispatch?.(["abcdefgh"]);
      return vi.mocked(enqueueIndexJobs).mock.calls.length > 0;
    };
    jobs.holdFailedListing("abcdefgh");
    expect(await dispatchedAfter(jobs.FAILED_HOLD_MS - 1)).toBe(false);
    expect(await dispatchedAfter(1)).toBe(true);
    jobs.holdFailedListing("abcdefgh");
    expect(await dispatchedAfter(2 * jobs.FAILED_HOLD_MS - 1)).toBe(false);
    expect(await dispatchedAfter(1)).toBe(true);
    for (let i = 0; i < 10; i += 1) jobs.holdFailedListing("abcdefgh");
    expect(await dispatchedAfter(jobs.FAILED_HOLD_MAX_MS - 1)).toBe(false);
    expect(await dispatchedAfter(1)).toBe(true);
    // A job that succeeds ends the run of failures.
    await jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } });
    jobs.holdFailedListing("abcdefgh");
    expect(await dispatchedAfter(jobs.FAILED_HOLD_MS)).toBe(true);
  });

  it("with index writes failing while reads answer, the poll dispatches the oldest entry alone until a write goes through", async () => {
    vi.useFakeTimers();
    vi.mocked(indexListing).mockRejectedValueOnce(new SearchUnavailableError("meilisearch 403 invalid_api_key"));
    await expect(jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } })).rejects.toBeInstanceOf(SearchUnavailableError);
    vi.advanceTimersByTime(jobs.ENGINE_BACKOFF_MS);
    const probe = await poll();
    expect(healthy).toHaveBeenCalled();
    expect(probe?.limit).toBe(1);
    await probe?.dispatch?.(["bcdefghj"]);
    expect(enqueueIndexJobs).toHaveBeenLastCalledWith(["bcdefghj"]);
    // A job that wrote nothing (entry already acknowledged) proves nothing.
    vi.mocked(indexListing).mockResolvedValueOnce({ id: "cdefghjk", action: "none", version: null, acked: true, pending: false, passes: 0 });
    await jobs.processSearchJob({ name: "index-listing", data: { id: "cdefghjk" } });
    expect((await poll())?.limit).toBe(1);
    vi.mocked(indexListing).mockResolvedValueOnce({ id: "bcdefghj", action: "upsert", version: 2, acked: true, pending: false, passes: 1 });
    await jobs.processSearchJob({ name: "index-listing", data: { id: "bcdefghj" } });
    expect((await poll())?.limit).toBe(200);
    // No write going through (the oldest entry held): a page again after FAILED_HOLD_MS.
    vi.mocked(indexListing).mockRejectedValueOnce(new SearchUnavailableError("meilisearch 403 invalid_api_key"));
    await expect(jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } })).rejects.toBeInstanceOf(SearchUnavailableError);
    vi.advanceTimersByTime(jobs.ENGINE_BACKOFF_MS);
    expect((await poll())?.limit).toBe(1);
    vi.advanceTimersByTime(jobs.FAILED_HOLD_MS);
    expect((await poll())?.limit).toBe(200);
  });

  it("reads only the oldest entry while the Firestore read quota is spent", async () => {
    degraded.add("firestore.reads");
    expect((await poll())?.limit).toBe(1);
    degraded.clear();
    expect((await poll())?.limit).toBe(200);
  });

  it("after an unavailable engine, index jobs fail fast without reading Firestore, then probe again", async () => {
    vi.useFakeTimers();
    vi.mocked(indexListing).mockRejectedValueOnce(new SearchUnavailableError("meilisearch unreachable"));
    await expect(jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } })).rejects.toBeInstanceOf(SearchUnavailableError);
    await expect(jobs.processSearchJob({ name: "index-listing", data: { id: "bcdefghj" } })).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(indexListing).toHaveBeenCalledTimes(1);
    // The poll does not even ask the engine during the backoff.
    expect((await poll())?.limit).toBe(1);
    expect(healthy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(jobs.ENGINE_BACKOFF_MS);
    await jobs.processSearchJob({ name: "index-listing", data: { id: "bcdefghj" } });
    expect(indexListing).toHaveBeenCalledTimes(2);
  });

  it("an expire-boost whose entry is written succeeds even with the engine down (the poll indexes it)", async () => {
    vi.mocked(indexListing).mockRejectedValueOnce(new SearchUnavailableError("meilisearch unreachable"));
    expect(await jobs.processSearchJob({ name: "expire-boost", data: { id: "abcdefgh", until: 1 } })).toBe(true);
    vi.mocked(indexListing).mockRejectedValueOnce(new Error("bug"));
    jobs.resetEngineReadyForTests();
    await expect(jobs.processSearchJob({ name: "expire-boost", data: { id: "abcdefgh", until: 1 } })).rejects.toThrow("bug");
  });

  it("expire-boost writes the entry then indexes; nothing when the boost was extended", async () => {
    expect(await jobs.processSearchJob({ name: "expire-boost", data: { id: "abcdefgh", until: 1 } })).toBe(true);
    expect(indexListing).toHaveBeenCalledWith("abcdefgh");
    vi.mocked(expireBoost).mockResolvedValueOnce(false);
    expect(await jobs.processSearchJob({ name: "expire-boost", data: { id: "abcdefgh", until: 1 } })).toBe(false);
    expect(indexListing).toHaveBeenCalledTimes(1);
  });

  it("a failed preparation is retried by the next job; an unconfigured engine rejects, never throws", async () => {
    ensureReady.mockRejectedValueOnce(new Error("meili down"));
    await expect(jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } })).rejects.toThrow("meili down");
    await jobs.processSearchJob({ name: "index-listing", data: { id: "abcdefgh" } });
    expect(ensureReady).toHaveBeenCalledTimes(2);

    jobs.resetEngineReadyForTests();
    engineState.throwOnAccess = true;
    const pending = jobs.ensureEngineReady();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow("not configured");
  });
});

type Next = (snapshot: { docChanges(): { type: "added" | "modified" | "removed"; doc: { id: string } }[] }) => void;

function fakeSubscribe() {
  const listeners: { next: Next; error: (error: Error) => void; unsubscribe: ReturnType<typeof vi.fn> }[] = [];
  const subscribe = vi.fn((next: Next, error: (error: Error) => void) => {
    const unsubscribe = vi.fn();
    listeners.push({ next, error, unsubscribe });
    return unsubscribe;
  });
  return { subscribe, listeners };
}

const changes = (...items: [type: "added" | "modified" | "removed", id: string][]) => ({ docChanges: () => items.map(([type, id]) => ({ type, doc: { id } })) });

describe("watchSearchOutbox", () => {
  it("enqueues added and changed entries and counts a read per delivered entry", async () => {
    const { subscribe, listeners } = fakeSubscribe();
    const dispatch = vi.fn(async () => undefined);
    const watch = jobs.watchSearchOutbox({ dispatch, subscribe });
    listeners[0]?.next(changes(["added", "aaaaaaaa"], ["modified", "bbbbbbbb"], ["removed", "cccccccc"]));
    expect(dispatch).toHaveBeenCalledWith(["aaaaaaaa", "bbbbbbbb"]);
    expect(consume).toHaveBeenCalledWith("firestore.reads", 2);
    listeners[0]?.next(changes(["removed", "aaaaaaaa"]));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
    watch.stop();
    expect(listeners[0]?.unsubscribe).toHaveBeenCalled();
  });

  it("an empty first snapshot still costs one read", () => {
    const { subscribe, listeners } = fakeSubscribe();
    jobs.watchSearchOutbox({ dispatch: async () => undefined, subscribe }).stop();
    listeners[0]?.next(changes());
    expect(consume).toHaveBeenCalledWith("firestore.reads", 1);
  });

  it("restarts after an error with a doubling backoff, reset by a good snapshot", async () => {
    vi.useFakeTimers();
    const { subscribe, listeners } = fakeSubscribe();
    const watch = jobs.watchSearchOutbox({ dispatch: async () => undefined, subscribe, minDelayMs: 1_000, maxDelayMs: 3_000 });
    listeners[0]?.error(new Error("UNAVAILABLE"));
    expect(listeners[0]?.unsubscribe).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    listeners[1]?.error(new Error("UNAVAILABLE"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribe).toHaveBeenCalledTimes(3);
    listeners[2]?.error(new Error("UNAVAILABLE"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(subscribe).toHaveBeenCalledTimes(4);
    listeners[3]?.next(changes());
    listeners[3]?.error(new Error("UNAVAILABLE"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscribe).toHaveBeenCalledTimes(5);
    watch.stop();
  });

  it("a throwing subscribe restarts too; stop() cancels a pending restart", async () => {
    vi.useFakeTimers();
    const subscribe = vi.fn(() => {
      throw new Error("no credentials");
    });
    const watch = jobs.watchSearchOutbox({ dispatch: async () => undefined, subscribe, minDelayMs: 1_000 });
    expect(subscribe).toHaveBeenCalledTimes(1);
    watch.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("a failed enqueue is logged, never thrown (the poll takes the entry)", async () => {
    const { subscribe, listeners } = fakeSubscribe();
    const dispatch = vi.fn(async () => Promise.reject(new Error("valkey down")));
    const watch = jobs.watchSearchOutbox({ dispatch, subscribe });
    listeners[0]?.next(changes(["added", "aaaaaaaa"]));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    watch.stop();
  });
});
