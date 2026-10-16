import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";

// End of À la Une (design D8): the delayed expire-boost job scheduled at sale time (best effort,
// never throws) and the transaction that writes the searchOutbox entry once the period ended.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })) }));
const queueState = { enabled: true };
const add = vi.fn<(name: string, data: unknown, opts: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
vi.mock("@/lib/search/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/search/queue")>()),
  isSearchQueueEnabled: () => queueState.enabled,
  searchQueue: () => ({ add }),
}));
const tx = { marker: "tx" };
vi.mock("@/lib/firebase/admin", () => ({ db: () => ({ runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }) }));
vi.mock("@/lib/db/repositories/listings", () => ({ getListingTx: vi.fn() }));
vi.mock("@/lib/db/repositories/search-outbox", () => ({ enqueueSearchOutboxTx: vi.fn() }));

const { getListingTx } = await import("@/lib/db/repositories/listings");
const { enqueueSearchOutboxTx } = await import("@/lib/db/repositories/search-outbox");
const boosts = await import("@/lib/search/boosts");

const NOW = new Date("2026-10-16T10:00:00Z");

beforeEach(() => {
  queueState.enabled = true;
  add.mockReset().mockResolvedValue({});
  vi.mocked(getListingTx).mockReset();
  vi.mocked(enqueueSearchOutboxTx).mockReset();
});

describe("scheduleBoostExpiry", () => {
  it("adds a delayed expire-boost job just after the end", async () => {
    const until = new Date(NOW.getTime() + 7 * 86_400_000);
    expect(await boosts.scheduleBoostExpiry("abcdefgh", until, NOW)).toBe(true);
    expect(add).toHaveBeenCalledWith("expire-boost", { id: "abcdefgh", until: until.getTime() }, expect.objectContaining({ jobId: `boost-abcdefgh-${until.getTime()}`, delay: 7 * 86_400_000 + 1_000, removeOnFail: true }));
  });

  it("an end already past fires at once", async () => {
    await boosts.scheduleBoostExpiry("abcdefgh", new Date(NOW.getTime() - 60_000), NOW);
    expect(add.mock.calls[0]?.[2]).toMatchObject({ delay: 1_000 });
  });

  it("returns false without the queue, for an invalid id, or when Valkey fails (never throws)", async () => {
    expect(await boosts.scheduleBoostExpiry("ABC", NOW, NOW)).toBe(false);
    expect(await boosts.scheduleBoostExpiry("abcdefgh", new Date(Number.NaN), NOW)).toBe(false);
    add.mockRejectedValueOnce(new Error("down"));
    expect(await boosts.scheduleBoostExpiry("abcdefgh", NOW, NOW)).toBe(false);
    queueState.enabled = false;
    expect(await boosts.scheduleBoostExpiry("abcdefgh", NOW, NOW)).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe("expireBoost", () => {
  const record = (overrides: Partial<ListingRecord>) => ({ id: "abcdefgh", status: "published", version: 12, boosts: {}, ...overrides }) as ListingRecord;

  it("writes an upsert entry at the listing's current version once the period ended", async () => {
    vi.mocked(getListingTx).mockResolvedValue(record({ boosts: { featuredUntil: new Date(NOW.getTime() - 1) } }));
    expect(await boosts.expireBoost("abcdefgh", NOW)).toBe(true);
    expect(enqueueSearchOutboxTx).toHaveBeenCalledWith(tx, "abcdefgh", "upsert", 12, NOW);
  });

  it("leaves an extended period, an unpublished or a missing listing alone", async () => {
    vi.mocked(getListingTx).mockResolvedValueOnce(record({ boosts: { featuredUntil: new Date(NOW.getTime() + 60_000) } }));
    expect(await boosts.expireBoost("abcdefgh", NOW)).toBe(false);
    vi.mocked(getListingTx).mockResolvedValueOnce(record({ status: "sold", boosts: { featuredUntil: new Date(NOW.getTime() - 1) } }));
    expect(await boosts.expireBoost("abcdefgh", NOW)).toBe(false);
    vi.mocked(getListingTx).mockResolvedValueOnce(null);
    expect(await boosts.expireBoost("abcdefgh", NOW)).toBe(false);
    expect(enqueueSearchOutboxTx).not.toHaveBeenCalled();
  });

  it("re-indexes a published listing whose boost was cleared", async () => {
    vi.mocked(getListingTx).mockResolvedValue(record({ boosts: {} }));
    expect(await boosts.expireBoost("abcdefgh", NOW)).toBe(true);
  });

  it("validates expire-boost payloads", () => {
    expect(boosts.boostJobSchema.safeParse({ id: "abcdefgh", until: NOW.getTime() }).success).toBe(true);
    expect(boosts.boostJobSchema.safeParse({ id: "abcdefgh" }).success).toBe(false);
  });
});
