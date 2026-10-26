import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { PublishedPage } from "@/lib/search/indexer";
import type { SearchDocument } from "@/lib/search/types";

// scripts/reindex-search.ts (design D12): dry run by default, read budget, build into listings_v2,
// swap, delete the old documents, catch-up of the listings changed during the build; a failure
// before the swap leaves the live index untouched.

vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async () => false) }));

const script = await import("../../scripts/reindex-search");

const NOW = new Date("2026-10-16T10:00:00Z");

function listing(id: string, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id,
    ownerUid: "owner",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status: "published",
    slugId: `velo-${id}`,
    title: "Vélo",
    description: "Vélo",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: {},
    price: 100,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.6, lng: -7.62 } },
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: true,
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  } as ListingRecord;
}

function fakeIndex(exists: boolean, documents = 0) {
  return {
    exists: vi.fn(async () => exists),
    stats: vi.fn(async () => ({ numberOfDocuments: documents, isIndexing: false })),
    ensureReady: vi.fn(async () => ({ created: true, settingsUpdated: true })),
    upsert: vi.fn(async (_documents: SearchDocument[]) => undefined),
    deleteIndex: vi.fn(async () => undefined),
    swapWith: vi.fn(async (_other: string) => undefined),
  };
}

let live: ReturnType<typeof fakeIndex>;
let next: ReturnType<typeof fakeIndex>;
let pages: PublishedPage[];
let lines: string[];
const deps = () => ({
  live,
  next,
  countPublished: vi.fn(async () => pages.reduce((sum, page) => sum + page.read, 0)),
  pages: async function* () {
    for (const page of pages) yield page;
  },
  changedSince: vi.fn(async (_since: Date, _limit: number) => ["cccccccc"]),
  enqueue: vi.fn(async (_ids: string[]) => undefined),
  readsDegraded: vi.fn(async () => false),
  now: () => NOW,
  log: (line: string) => void lines.push(line),
});

beforeEach(() => {
  live = fakeIndex(true, 2);
  next = fakeIndex(false);
  lines = [];
  pages = [
    { listings: [listing("aaaaaaaa"), listing("bbbbbbbb", { moderation: { state: "needs_review", score: 70, flags: [], openReports: 0 } })], read: 2 },
    { listings: [listing("dddddddd")], read: 1 },
  ];
});

describe("parseCli", () => {
  it("dry run by default, --apply and --max-reads", () => {
    expect(script.parseCli([])).toEqual({ apply: false, maxReads: script.DEFAULT_MAX_READS });
    expect(script.parseCli(["--apply", "--max-reads", "5000"])).toEqual({ apply: true, maxReads: 5000 });
    expect(() => script.parseCli(["--max-reads", "-1"])).toThrow("--max-reads");
    expect(() => script.parseCli(["--max-reads", "abc"])).toThrow("--max-reads");
    expect(() => script.parseCli(["--force"])).toThrow();
  });
});

describe("reindex", () => {
  it("dry run: counts and prints the plan, writes nothing", async () => {
    const d = deps();
    const report = await script.reindex({ apply: false, maxReads: 20_000 }, d);
    expect(report).toMatchObject({ applied: false, published: 3, indexed: 0 });
    expect(lines.join("\n")).toContain("Dry run");
    expect(lines[0]).toContain("listings_v1: 2 document(s)");
    expect(next.ensureReady).not.toHaveBeenCalled();
    expect(live.swapWith).not.toHaveBeenCalled();
  });

  it("apply: builds listings_v2, swaps, deletes the old documents, catches up", async () => {
    next = fakeIndex(true);
    const d = deps();
    const report = await script.reindex({ apply: true, maxReads: 20_000 }, d);
    expect(report).toMatchObject({ applied: true, published: 3, indexed: 2, skipped: 1, caughtUp: 1 });
    // The leftover rebuild index goes first, then it is created with the settings.
    expect(next.deleteIndex.mock.invocationCallOrder[0]).toBeLessThan(next.ensureReady.mock.invocationCallOrder[0]!);
    expect(next.upsert.mock.calls.map(([documents]) => documents.map((doc) => doc.id))).toEqual([["aaaaaaaa"], ["dddddddd"]]);
    expect(live.swapWith).toHaveBeenCalledWith("listings_v2");
    expect(next.deleteIndex).toHaveBeenCalledTimes(2);
    expect(next.deleteIndex.mock.invocationCallOrder[1]).toBeGreaterThan(live.swapWith.mock.invocationCallOrder[0]!);
    expect(d.changedSince).toHaveBeenCalledWith(NOW, script.CATCH_UP_MAX);
    expect(d.enqueue).toHaveBeenCalledWith(["cccccccc"]);
  });

  it("refuses before any write when the budget is too small or the read quota degraded", async () => {
    await expect(script.reindex({ apply: true, maxReads: 100 }, deps())).rejects.toThrow("rerun with --max-reads 2004 or more");
    const d = deps();
    d.readsDegraded.mockResolvedValue(true);
    await expect(script.reindex({ apply: true, maxReads: 20_000 }, d)).rejects.toThrow("degraded");
    expect(next.ensureReady).not.toHaveBeenCalled();
  });

  it("a failure during the build deletes listings_v2 and never swaps", async () => {
    next.upsert.mockRejectedValueOnce(new Error("task failed"));
    await expect(script.reindex({ apply: true, maxReads: 20_000 }, deps())).rejects.toThrow("task failed");
    expect(next.deleteIndex).toHaveBeenCalledTimes(1);
    expect(live.swapWith).not.toHaveBeenCalled();
  });

  it("stops at the read budget during the build", async () => {
    pages = [{ listings: [], read: 18_000 }];
    const d = deps();
    d.countPublished.mockResolvedValue(10);
    await expect(script.reindex({ apply: true, maxReads: 20_000 }, d)).rejects.toThrow("read budget");
    expect(live.swapWith).not.toHaveBeenCalled();
  });
});
