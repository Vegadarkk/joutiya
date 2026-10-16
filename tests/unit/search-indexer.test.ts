import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { SearchDocument, SearchEngine } from "@/lib/search/types";

// The indexer (design D9, D10): one listing from its outbox entry with the ackSearchOutbox version
// check (a newer entry -> one more pass, at most 3), the 60 s poll with its lag (P1 alert past
// 5 min, fake clock), and the development rebuild. Repositories, Firestore and the engine are fakes.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async () => false) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
const valkeyClient = { set: vi.fn(async () => "OK"), get: vi.fn<(key: string) => Promise<string | null>>(async () => null) };
const valkeyConfigured = { value: true };
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => valkeyConfigured.value, valkey: () => valkeyClient }));
vi.mock("@/lib/db/repositories/search-outbox", () => ({ getSearchOutbox: vi.fn(), ackSearchOutbox: vi.fn() }));
vi.mock("@/lib/db/repositories/listings", () => ({
  getListing: vi.fn(),
  fromSnapshot: (snapshot: { record: ListingRecord | null }) => snapshot.record,
}));

/** Minimal chainable Firestore query over in-memory snapshot pages. */
interface FakeDoc {
  id: string;
  data(): Record<string, unknown>;
  record?: ListingRecord | null;
}
let pages: FakeDoc[][] = [];
const queryLog: string[] = [];
function fakeQuery(): Record<string, unknown> {
  const query: Record<string, unknown> = {
    where: (...args: unknown[]) => (queryLog.push(`where ${String(args[0])}`), query),
    orderBy: (field: unknown) => (queryLog.push(`orderBy ${String(field)}`), query),
    startAfter: (id: unknown) => (queryLog.push(`startAfter ${String(id)}`), query),
    limit: (n: number) => (queryLog.push(`limit ${n}`), query),
    get: async () => {
      const docs = pages.shift() ?? [];
      return { docs, size: docs.length };
    },
  };
  return query;
}
vi.mock("@/lib/firebase/admin", () => ({ db: () => ({ collection: () => fakeQuery() }) }));

class FakeEngine {
  readonly kind = "memory" as const;
  docs = new Map<string, SearchDocument>();
  upsert = vi.fn(async (documents: SearchDocument[]) => {
    for (const doc of documents) this.docs.set(doc.id, doc);
  });
  remove = vi.fn(async (ids: string[]) => {
    for (const id of ids) this.docs.delete(id);
  });
  ensureReady = vi.fn(async () => ({ created: false, settingsUpdated: false }));
  async *versions(): AsyncIterable<{ id: string; version: number }[]> {
    yield [...this.docs.values()].map((doc) => ({ id: doc.id, version: doc.version }));
  }
}
let engine: FakeEngine;
vi.mock("@/lib/search/engine", () => ({ searchEngine: () => engine as unknown as SearchEngine }));

const outbox = await import("@/lib/db/repositories/search-outbox");
const listings = await import("@/lib/db/repositories/listings");
const { alert } = await import("@/lib/alert");
const indexer = await import("@/lib/search/indexer");

const NOW = new Date("2026-10-16T10:00:00Z");

function listing(id: string, version: number, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id,
    ownerUid: "owner",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status: "published",
    slugId: `velo-${id}`,
    title: `Vélo ${version}`,
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
    version,
    ...overrides,
  } as ListingRecord;
}

const entry = (version: number) => ({ op: "upsert" as const, version, enqueuedAt: NOW });

beforeEach(() => {
  engine = new FakeEngine();
  pages = [];
  queryLog.length = 0;
  valkeyConfigured.value = true;
  valkeyClient.set.mockClear();
  valkeyClient.get.mockReset().mockResolvedValue(null);
  vi.mocked(alert).mockClear();
  vi.mocked(outbox.getSearchOutbox).mockReset();
  vi.mocked(outbox.ackSearchOutbox).mockReset();
  vi.mocked(listings.getListing).mockReset();
});

describe("indexListing", () => {
  it("does nothing when the entry is gone (already indexed)", async () => {
    vi.mocked(outbox.getSearchOutbox).mockResolvedValue(null);
    expect(await indexer.indexListing("abcdefgh")).toEqual({ id: "abcdefgh", action: "none", version: null, acked: true, pending: false, passes: 0 });
    expect(listings.getListing).not.toHaveBeenCalled();
    expect(engine.upsert).not.toHaveBeenCalled();
  });

  it("upserts an indexable listing and acknowledges the entry's version", async () => {
    vi.mocked(outbox.getSearchOutbox).mockResolvedValue(entry(4));
    vi.mocked(listings.getListing).mockResolvedValue(listing("abcdefgh", 4));
    vi.mocked(outbox.ackSearchOutbox).mockResolvedValue(true);
    const outcome = await indexer.indexListing("abcdefgh");
    expect(outcome).toMatchObject({ action: "upsert", version: 4, acked: true, pending: false, passes: 1 });
    expect(engine.docs.get("abcdefgh")).toMatchObject({ version: 4, title: "Vélo 4" });
    expect(outbox.ackSearchOutbox).toHaveBeenCalledWith("abcdefgh", 4);
  });

  it.each([
    ["is not indexable any more", listing("abcdefgh", 5, { status: "paused" })],
    ["is a tombstone or missing", null],
  ])("removes the document when the listing %s", async (_label, record) => {
    engine.docs.set("abcdefgh", { id: "abcdefgh", version: 4 } as SearchDocument);
    vi.mocked(outbox.getSearchOutbox).mockResolvedValue({ op: "delete", version: 5, enqueuedAt: NOW });
    vi.mocked(listings.getListing).mockResolvedValue(record);
    vi.mocked(outbox.ackSearchOutbox).mockResolvedValue(true);
    expect(await indexer.indexListing("abcdefgh")).toMatchObject({ action: "remove", version: null, acked: true });
    expect(engine.docs.has("abcdefgh")).toBe(false);
  });

  it("version race: a newer entry written while indexing gets one more pass", async () => {
    // Pass 1 reads entry v4, then the owner edits (v5) before the ack: the ack of v4 fails.
    vi.mocked(outbox.getSearchOutbox).mockResolvedValueOnce(entry(4)).mockResolvedValueOnce(entry(5));
    vi.mocked(listings.getListing).mockResolvedValueOnce(listing("abcdefgh", 4)).mockResolvedValueOnce(listing("abcdefgh", 5));
    vi.mocked(outbox.ackSearchOutbox).mockImplementation(async (_id, version) => version === 5);
    const outcome = await indexer.indexListing("abcdefgh");
    expect(outcome).toMatchObject({ action: "upsert", version: 5, acked: true, pending: false, passes: 2 });
    expect(vi.mocked(outbox.ackSearchOutbox).mock.calls).toEqual([
      ["abcdefgh", 4],
      ["abcdefgh", 5],
    ]);
    expect(engine.docs.get("abcdefgh")).toMatchObject({ version: 5, title: "Vélo 5" });
  });

  it("leaves a still-moving entry to the poll after 3 passes", async () => {
    let version = 4;
    vi.mocked(outbox.getSearchOutbox).mockImplementation(async () => entry(version));
    vi.mocked(listings.getListing).mockImplementation(async () => listing("abcdefgh", version));
    vi.mocked(outbox.ackSearchOutbox).mockImplementation(async () => {
      version += 1;
      return false;
    });
    expect(await indexer.indexListing("abcdefgh")).toMatchObject({ pending: true, acked: false, passes: indexer.INDEX_MAX_PASSES });
    expect(outbox.ackSearchOutbox).toHaveBeenCalledTimes(indexer.INDEX_MAX_PASSES);
  });

  it("forced (reconciliation): indexes from the listing without an entry", async () => {
    vi.mocked(outbox.getSearchOutbox).mockResolvedValue(null);
    vi.mocked(listings.getListing).mockResolvedValue(listing("abcdefgh", 9));
    expect(await indexer.indexListing("abcdefgh", { force: true })).toMatchObject({ action: "upsert", version: 9, acked: true, passes: 1 });
    expect(outbox.ackSearchOutbox).not.toHaveBeenCalled();
  });

  it("throws when the engine fails, without acknowledging (the job retries, the poll keeps the entry)", async () => {
    vi.mocked(outbox.getSearchOutbox).mockResolvedValue(entry(4));
    vi.mocked(listings.getListing).mockResolvedValue(listing("abcdefgh", 4));
    engine.upsert.mockRejectedValueOnce(new Error("engine down"));
    await expect(indexer.indexListing("abcdefgh")).rejects.toThrow("engine down");
    expect(outbox.ackSearchOutbox).not.toHaveBeenCalled();
  });
});

function outboxDoc(id: string, enqueuedAt: Date): FakeDoc {
  return { id, data: () => ({ op: "upsert", version: 1, enqueuedAt: Timestamp.fromDate(enqueuedAt) }) };
}

describe("processOutbox (poll, lag alert)", () => {
  it("dispatches the oldest entries and stores the lag", async () => {
    pages = [[outboxDoc("aaaaaaaa", new Date(NOW.getTime() - 90_000)), outboxDoc("bbbbbbbb", new Date(NOW.getTime() - 30_000))]];
    const dispatch = vi.fn(async () => undefined);
    const result = await indexer.processOutbox({ now: NOW, dispatch });
    expect(result).toEqual({ pending: 2, lagSeconds: 90, alerted: false });
    expect(dispatch).toHaveBeenCalledWith(["aaaaaaaa", "bbbbbbbb"]);
    expect(queryLog).toEqual(["orderBy enqueuedAt", `limit ${indexer.OUTBOX_POLL_LIMIT}`]);
    expect(valkeyClient.set).toHaveBeenCalledWith(indexer.SEARCH_LAG_KEY, "90", "EX", indexer.SEARCH_LAG_TTL_SECONDS);
    expect(alert).not.toHaveBeenCalled();
  });

  it("raises the P1 alert when the oldest entry waits more than 5 minutes (fake clock)", async () => {
    const enqueuedAt = new Date("2026-10-16T09:00:00Z");
    pages = [[outboxDoc("aaaaaaaa", enqueuedAt)]];
    const atFiveMinutes = await indexer.processOutbox({ now: new Date(enqueuedAt.getTime() + 300_000), dispatch: async () => undefined });
    expect(atFiveMinutes).toMatchObject({ lagSeconds: 300, alerted: false });
    expect(alert).not.toHaveBeenCalled();

    pages = [[outboxDoc("aaaaaaaa", enqueuedAt)]];
    const later = await indexer.processOutbox({ now: new Date(enqueuedAt.getTime() + 361_000), dispatch: async () => undefined });
    expect(later).toMatchObject({ lagSeconds: 361, alerted: true });
    expect(alert).toHaveBeenCalledWith({ severity: "P1", title: "Indexation de la recherche en retard", body: expect.stringContaining("6 min") });
  });

  it("an empty outbox has no lag and dispatches nothing", async () => {
    const dispatch = vi.fn(async () => undefined);
    expect(await indexer.processOutbox({ now: NOW, dispatch })).toEqual({ pending: 0, lagSeconds: 0, alerted: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(valkeyClient.set).toHaveBeenCalledWith(indexer.SEARCH_LAG_KEY, "0", "EX", indexer.SEARCH_LAG_TTL_SECONDS);
  });

  it("without Valkey still alerts; a failing Valkey never throws", async () => {
    valkeyConfigured.value = false;
    expect(await indexer.reportOutboxLag(600, 1)).toBe(true);
    expect(valkeyClient.set).not.toHaveBeenCalled();
    valkeyConfigured.value = true;
    valkeyClient.set.mockRejectedValueOnce(new Error("down"));
    await expect(indexer.reportOutboxLag(10, 1)).resolves.toBe(false);
  });

  it("reads back the stored lag for the alerts job; unknown when missing, malformed or unreadable", async () => {
    valkeyClient.get.mockResolvedValueOnce("420");
    expect(await indexer.readOutboxLag()).toBe(420);
    expect(valkeyClient.get).toHaveBeenCalledWith(indexer.SEARCH_LAG_KEY);
    expect(await indexer.readOutboxLag()).toBeNull();
    valkeyClient.get.mockResolvedValueOnce("soon");
    expect(await indexer.readOutboxLag()).toBeNull();
    valkeyClient.get.mockRejectedValueOnce(new Error("down"));
    expect(await indexer.readOutboxLag()).toBeNull();
    valkeyConfigured.value = false;
    expect(await indexer.readOutboxLag()).toBeNull();
  });

  it("indexes inline by default, one failure not stopping the others", async () => {
    pages = [[outboxDoc("aaaaaaaa", NOW), outboxDoc("bbbbbbbb", NOW)]];
    vi.mocked(outbox.getSearchOutbox).mockImplementation(async (id) => (id === "aaaaaaaa" ? Promise.reject(new Error("read failed")) : entry(2)));
    vi.mocked(listings.getListing).mockResolvedValue(listing("bbbbbbbb", 2));
    vi.mocked(outbox.ackSearchOutbox).mockResolvedValue(true);
    await indexer.processOutbox({ now: NOW });
    expect(engine.docs.has("bbbbbbbb")).toBe(true);
  });

  it("outboxLagSeconds never goes negative", () => {
    expect(indexer.outboxLagSeconds(null, NOW)).toBe(0);
    expect(indexer.outboxLagSeconds(new Date(NOW.getTime() + 5_000), NOW)).toBe(0);
    expect(indexer.outboxLagSeconds(new Date(NOW.getTime() - 61_500), NOW)).toBe(61);
  });
});

describe("rebuildFromFirestore (dev route)", () => {
  it("indexes every indexable published listing and drops every other document", async () => {
    engine.docs.set("zzzzzzzz", { id: "zzzzzzzz", version: 1 } as SearchDocument);
    const docs = (records: ListingRecord[]): FakeDoc[] => records.map((record) => ({ id: record.id, data: () => ({}), record }));
    const full = Array.from({ length: indexer.PUBLISHED_PAGE_SIZE }, (_, i) => listing(`a${String(i).padStart(3, "0")}bcdf`.replace(/[01]/g, "2"), 1));
    pages = [docs(full), docs([listing("cccccccc", 3), listing("dddddddd", 1, { moderation: { state: "needs_review", score: 70, flags: [], openReports: 0 } })])];
    const result = await indexer.rebuildFromFirestore(NOW);
    expect(result.indexed).toBe(new Set(full.map((record) => record.id)).size + 1);
    expect(result).toMatchObject({ removed: 1, skipped: 1 });
    expect(engine.docs.has("zzzzzzzz")).toBe(false);
    expect(engine.docs.get("cccccccc")?.version).toBe(3);
    expect(engine.ensureReady).toHaveBeenCalled();
    expect(queryLog.filter((line) => line.startsWith("startAfter"))).toHaveLength(1);
  });
});
