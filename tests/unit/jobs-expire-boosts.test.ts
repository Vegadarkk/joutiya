import { beforeEach, describe, expect, it, vi } from "vitest";

// expire-boosts (04:05 UTC, design D8): safety net of the delayed expire-boost jobs. Boosts ended
// since the last sweep get their outbox entry and go to the search queue; the cursor moves to now,
// to the last end reached when the page budget runs out, or back to a failed listing's end.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false) }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value }));
vi.mock("@/lib/search/boosts", () => ({
  expireBoost: vi.fn(async () => true),
  listBoostsEndedBetween: vi.fn(),
  readBoostSweepCursor: vi.fn(async () => null),
  writeBoostSweepCursor: vi.fn(async () => undefined),
}));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));

const boosts = await import("@/lib/search/boosts");
const { notifySearchIndex } = await import("@/lib/search/queue");
const { isDegraded } = await import("@/lib/quota");
const { BOOST_SWEEP_BATCH, BOOST_SWEEP_LOOKBACK_MS, BOOST_SWEEP_PAGES, sweepExpiredBoosts } = await import("@/worker/jobs/expire-boosts");

const NOW = new Date("2026-10-16T04:05:00Z");
const HOUR = 3_600_000;

function page(ids: string[], ends: Date[], read = ids.length) {
  const lastId = ids[ids.length - 1];
  const lastEnd = ends[ends.length - 1];
  return { ids, ends, read, ...(lastId && lastEnd ? { next: { at: lastEnd, id: lastId } } : {}) };
}

beforeEach(() => {
  configured.value = true;
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(boosts.expireBoost).mockReset().mockResolvedValue(true);
  vi.mocked(boosts.listBoostsEndedBetween).mockReset().mockResolvedValue(page([], []));
  vi.mocked(boosts.readBoostSweepCursor).mockReset().mockResolvedValue(null);
  vi.mocked(boosts.writeBoostSweepCursor).mockClear();
  vi.mocked(notifySearchIndex).mockClear();
});

describe("sweepExpiredBoosts", () => {
  it("first run: looks back 7 days, writes the entries, notifies, moves the cursor to now", async () => {
    vi.mocked(boosts.listBoostsEndedBetween).mockResolvedValueOnce(page(["aaaaaaaa", "bbbbbbbb"], [new Date(NOW.getTime() - 2 * HOUR), new Date(NOW.getTime() - HOUR)]));
    vi.mocked(boosts.expireBoost).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await sweepExpiredBoosts(NOW);
    expect(result).toEqual({ expired: 1, skipped: 1, failed: 0, partial: false });
    expect(boosts.listBoostsEndedBetween).toHaveBeenCalledWith(new Date(NOW.getTime() - BOOST_SWEEP_LOOKBACK_MS), NOW, BOOST_SWEEP_BATCH, undefined);
    expect(boosts.expireBoost).toHaveBeenCalledWith("aaaaaaaa", NOW);
    expect(notifySearchIndex).toHaveBeenCalledWith(["aaaaaaaa"]);
    expect(boosts.writeBoostSweepCursor).toHaveBeenCalledWith(NOW, NOW);
  });

  it("resumes from the stored cursor and pages with the query cursor", async () => {
    const last = new Date(NOW.getTime() - 24 * HOUR);
    vi.mocked(boosts.readBoostSweepCursor).mockResolvedValue(last);
    const ids = Array.from({ length: BOOST_SWEEP_BATCH }, (_, i) => `aaaa${String(i).padStart(4, "2").replace(/[01]/g, "3")}`);
    const ends = ids.map((_, i) => new Date(last.getTime() + i * 1_000));
    vi.mocked(boosts.listBoostsEndedBetween).mockResolvedValueOnce(page(ids, ends)).mockResolvedValueOnce(page([], []));
    await sweepExpiredBoosts(NOW);
    const calls = vi.mocked(boosts.listBoostsEndedBetween).mock.calls;
    expect(calls[0]?.[0]).toEqual(last);
    expect(calls[1]?.[3]).toEqual({ at: ends[ends.length - 1], id: ids[ids.length - 1] });
  });

  it("stops at the page budget and keeps the last end reached", async () => {
    let n = 0;
    vi.mocked(boosts.listBoostsEndedBetween).mockImplementation(async () => {
      n += 1;
      const ids = Array.from({ length: BOOST_SWEEP_BATCH }, () => "aaaaaaaa");
      const ends = ids.map(() => new Date(NOW.getTime() - 100 * HOUR + n * HOUR));
      return page(ids, ends);
    });
    const result = await sweepExpiredBoosts(NOW);
    expect(result.partial).toBe(true);
    expect(boosts.listBoostsEndedBetween).toHaveBeenCalledTimes(BOOST_SWEEP_PAGES);
    expect(boosts.writeBoostSweepCursor).toHaveBeenCalledWith(new Date(NOW.getTime() - 100 * HOUR + BOOST_SWEEP_PAGES * HOUR), NOW);
  });

  it("a failed listing moves the cursor back to its end (retried next night)", async () => {
    const failedEnd = new Date(NOW.getTime() - 3 * HOUR);
    vi.mocked(boosts.listBoostsEndedBetween).mockResolvedValueOnce(page(["aaaaaaaa", "bbbbbbbb"], [failedEnd, new Date(NOW.getTime() - HOUR)]));
    vi.mocked(boosts.expireBoost).mockRejectedValueOnce(new Error("contention")).mockResolvedValueOnce(true);
    const result = await sweepExpiredBoosts(NOW);
    expect(result).toMatchObject({ expired: 1, failed: 1 });
    expect(notifySearchIndex).toHaveBeenCalledWith(["bbbbbbbb"]);
    expect(boosts.writeBoostSweepCursor).toHaveBeenCalledWith(failedEnd, NOW);
  });

  it("does nothing when Firebase is missing or the write quota is degraded", async () => {
    configured.value = false;
    expect(await sweepExpiredBoosts(NOW)).toMatchObject({ expired: 0 });
    configured.value = true;
    vi.mocked(isDegraded).mockResolvedValue(true);
    expect(await sweepExpiredBoosts(NOW)).toMatchObject({ expired: 0 });
    expect(boosts.listBoostsEndedBetween).not.toHaveBeenCalled();
    expect(boosts.writeBoostSweepCursor).not.toHaveBeenCalled();
  });
});
