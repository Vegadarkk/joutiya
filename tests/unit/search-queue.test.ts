import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Queue "search" producers (design D9): job ids and options, the web's fast lane (best effort,
// 1 s, never throws), worker-side producers (forced jobs for the reconciliation) and the inline
// fallback without QUEUE_REDIS_URL (serialized, failures logged).

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const env: { QUEUE_REDIS_URL?: string } = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));
vi.mock("@/lib/valkey/clients", () => ({ clientOptions: (_role: string, overrides: object) => overrides }));
vi.mock("ioredis", () => ({
  Redis: class {
    quit = vi.fn(async () => "OK");
  },
}));
const addBulk = vi.fn<(jobs: unknown[]) => Promise<unknown>>(async () => []);
const close = vi.fn(async () => undefined);
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(readonly name: string) {}
    addBulk = addBulk;
    close = close;
  },
}));
vi.mock("@/lib/search/indexer", () => ({ indexListing: vi.fn(async () => ({})) }));

const { logger } = await import("@/lib/logging/logger");
const { indexListing } = await import("@/lib/search/indexer");
const queue = await import("@/lib/search/queue");

beforeEach(() => {
  delete env.QUEUE_REDIS_URL;
  addBulk.mockReset().mockResolvedValue([]);
  vi.mocked(indexListing).mockReset().mockResolvedValue({ id: "", action: "none", version: null, acked: true, pending: false, passes: 0 });
  vi.mocked(logger.warn).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  await queue.closeSearchQueue();
});

describe("job ids and options", () => {
  it("outbox-driven and forced jobs never share an id", () => {
    expect(queue.indexJobId("abcdefgh")).toBe("idx-abcdefgh");
    expect(queue.indexJobId("abcdefgh", true)).toBe("rec-abcdefgh");
  });

  it("removes failed jobs so they never block the next add", () => {
    expect(queue.SEARCH_JOB_OPTIONS).toMatchObject({ attempts: 5, removeOnComplete: true, removeOnFail: true });
  });

  it("validates job payloads", () => {
    expect(queue.indexJobSchema.safeParse({ id: "abcdefgh" }).success).toBe(true);
    expect(queue.indexJobSchema.safeParse({ id: "abcdefgh", force: true }).success).toBe(true);
    expect(queue.indexJobSchema.safeParse({ id: "ABCDEFGH" }).success).toBe(false);
    expect(queue.indexJobSchema.safeParse({ id: "abcdefgh", extra: 1 }).success).toBe(false);
  });
});

describe("notifySearchIndex (fast lane)", () => {
  it("adds one job per distinct valid listing id", async () => {
    env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    await queue.notifySearchIndex(["abcdefgh", "abcdefgh", "not-an-id", "bcdefghj"]);
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0]?.[0]).toEqual([
      { name: "index-listing", data: { id: "abcdefgh" }, opts: { ...queue.SEARCH_JOB_OPTIONS, jobId: "idx-abcdefgh" } },
      { name: "index-listing", data: { id: "bcdefghj" }, opts: { ...queue.SEARCH_JOB_OPTIONS, jobId: "idx-bcdefghj" } },
    ]);
  });

  it("never throws when Valkey refuses the jobs", async () => {
    env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    addBulk.mockRejectedValueOnce(new Error("READONLY"));
    await expect(queue.notifySearchIndex(["abcdefgh"])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("gives up after 1 s when Valkey does not answer", async () => {
    env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    vi.useFakeTimers();
    addBulk.mockImplementationOnce(() => new Promise(() => undefined));
    let settled = false;
    const pending = queue.notifySearchIndex(["abcdefgh"]).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(queue.NOTIFY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("indexes inline without QUEUE_REDIS_URL, one listing after the other, never throwing", async () => {
    const order: string[] = [];
    vi.mocked(indexListing).mockImplementation(async (id) => {
      order.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${id}`);
      if (id === "bcdefghj") throw new Error("engine down");
      return { id, action: "upsert", version: 1, acked: true, pending: false, passes: 1 };
    });
    await Promise.all([queue.notifySearchIndex(["abcdefgh"]), queue.notifySearchIndex(["bcdefghj", "cdefghjk"])]);
    expect(order).toEqual(["start abcdefgh", "end abcdefgh", "start bcdefghj", "end bcdefghj", "start cdefghjk", "end cdefghjk"]);
    expect(indexListing).toHaveBeenCalledWith("abcdefgh", { force: false });
    expect(addBulk).not.toHaveBeenCalled();
  });

  it("ignores an empty or invalid list", async () => {
    await queue.notifySearchIndex([]);
    await queue.notifySearchIndex(["../etc"]);
    expect(indexListing).not.toHaveBeenCalled();
  });
});

describe("enqueueIndex (worker-side producers)", () => {
  it("forced jobs carry force and their own id", async () => {
    env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    await queue.enqueueIndex(["abcdefgh"], { force: true });
    expect(addBulk.mock.calls[0]?.[0]).toEqual([{ name: "index-listing", data: { id: "abcdefgh", force: true }, opts: { ...queue.SEARCH_JOB_OPTIONS, jobId: "rec-abcdefgh" } }]);
  });

  it("adds at most 500 jobs per call", async () => {
    env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const ids = Array.from({ length: 1_001 }, (_, i) => `aaaaa${alphabet[Math.floor(i / 900) % 31]}${alphabet[Math.floor(i / 30) % 31]}${alphabet[i % 30]}`);
    await queue.enqueueIndex(ids);
    expect(addBulk.mock.calls.map((call) => (call[0] as unknown[]).length)).toEqual([500, 500, 1]);
  });

  it("throws when the queue refuses (the caller decides)", async () => {
    env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    addBulk.mockRejectedValueOnce(new Error("OOM"));
    await expect(queue.enqueueIndex(["abcdefgh"])).rejects.toThrow("OOM");
  });

  it("indexes inline (forced) without Valkey", async () => {
    await queue.enqueueIndex(["abcdefgh"], { force: true });
    expect(indexListing).toHaveBeenCalledWith("abcdefgh", { force: true });
  });
});
