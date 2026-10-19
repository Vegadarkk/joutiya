import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FAVORITES_MAX, FAVORITES_PAGE_SIZE } from "@/lib/contracts/search";
import type { FavoriteDoc, FavoriteSnapshot } from "@/lib/db/schemas";
import type { FavoriteRecord } from "@/lib/favorites/repository";
import { setFavoriteCacheClientForTests } from "@/lib/favorites/ids-cache";
import { setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";
import { SearchUnavailableError, sitemapShardOf, type SearchDocument, type SearchEngine } from "@/lib/search/types";

// D17 service rules: a favorite needs an indexed listing (card from the engine, snapshot stored),
// adding twice answers the stored one, the cap, the counter only moves on real changes, and the
// page serves live cards, snapshots of the listings gone, snapshots as-is with the engine down.
// Firestore is replaced by an in-memory repository; Valkey is off (the subcollection answers).

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let rows: Map<string, FavoriteRecord>;
vi.mock("@/lib/favorites/repository", () => ({
  getFavorite: vi.fn(async (_uid: string, id: string) => rows.get(id) ?? null),
  createFavorite: vi.fn(async (_uid: string, id: string, doc: Omit<FavoriteDoc, "listingId">) => {
    if (rows.has(id)) return false;
    rows.set(id, { listingId: id, ...doc });
    return true;
  }),
  deleteFavorite: vi.fn(async (_uid: string, id: string) => rows.delete(id)),
  listFavoriteIds: vi.fn(async (_uid: string, limit: number) => [...rows.keys()].slice(0, limit)),
  listFavoritesPage: vi.fn(async (_uid: string, limit: number) => {
    const sorted = [...rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const page = sorted.slice(0, limit);
    const last = page[page.length - 1];
    return { favorites: page, ...(sorted.length > limit && last ? { next: { at: last.createdAt, id: last.listingId } } : {}) };
  }),
}));

const repository = await import("@/lib/favorites/repository");
const { addFavorite, favoritesPage, removeFavorite } = await import("@/lib/favorites/service");

const NOW = new Date("2026-10-16T09:00:00Z");
const SNAPSHOT: FavoriteSnapshot = { slugId: "velo-pqrs2345", title: "Vélo", subcategoryId: "velos", price: null, priceNegotiable: false, isDonation: false, citySlug: null, photo: null, photoCount: 0, sellerType: "individual" };

function doc(id: string, title = `Vélo ${id}`): SearchDocument {
  return {
    id,
    slugId: `velo-${id}`,
    title,
    description: "",
    categoryText: "",
    placeText: "Rabat",
    attrsText: "",
    categoryId: "vehicules",
    subcategoryId: "velos",
    regionCode: "04",
    citySlug: "rabat",
    sellerType: "individual",
    sellerPublicId: "abcdefghjk",
    price: 900,
    priceNegotiable: false,
    isDonation: false,
    hasPhoto: false,
    photoCount: 0,
    sortAt: NOW.getTime() - 3_600_000,
    updatedAt: NOW.getTime() - 3_600_000,
    sitemapShard: sitemapShardOf(id),
    isBumped: false,
    _geo: { lat: 34.02, lng: -6.83 },
    version: 1,
  };
}

let engine: MemoryEngine;

beforeEach(async () => {
  rows = new Map();
  setFavoriteCacheClientForTests(null);
  engine = new MemoryEngine();
  await engine.upsert([doc("abcd2345"), doc("efgh2345"), doc("jkmn2345")]);
  setSearchEngineForTests(engine);
  vi.mocked(repository.createFavorite).mockClear();
});

afterAll(() => {
  setFavoriteCacheClientForTests(undefined);
  setSearchEngineForTests(null);
});

describe("addFavorite", () => {
  it("stores the indexed card's snapshot, then answers the stored favorite on a second add", async () => {
    const first = await addFavorite("uid-1", "abcd2345", NOW);
    expect(first.created).toBe(true);
    expect(first.favorite).toMatchObject({ listingId: "abcd2345", createdAt: NOW.toISOString(), available: true, card: { title: "Vélo abcd2345", price: 900 } });
    expect(rows.get("abcd2345")?.listingSnapshot).toMatchObject({ title: "Vélo abcd2345", slugId: "velo-abcd2345", citySlug: "rabat" });
    const again = await addFavorite("uid-1", "abcd2345", new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ created: false, favorite: { createdAt: NOW.toISOString() } });
    expect(repository.createFavorite).toHaveBeenCalledTimes(1);
  });

  it("refuses a listing out of the index, past the cap, and with the engine down", async () => {
    await expect(addFavorite("uid-1", "zzzz2345", NOW)).rejects.toMatchObject({ status: 409, code: "listing_unavailable" });
    for (let index = 0; index < FAVORITES_MAX; index += 1) rows.set(`id${index}`, { listingId: `id${index}`, createdAt: NOW, listingSnapshot: SNAPSHOT });
    await expect(addFavorite("uid-1", "abcd2345", NOW)).rejects.toMatchObject({ status: 409, code: "favorite_limit" });
    rows.clear();
    setSearchEngineForTests({ search: async () => Promise.reject(new SearchUnavailableError()) } as unknown as SearchEngine);
    await expect(addFavorite("uid-1", "abcd2345", NOW)).rejects.toMatchObject({ status: 503, code: "search_unavailable" });
  });

  it("answers the winner of a parallel add without creating twice", async () => {
    vi.mocked(repository.createFavorite).mockImplementationOnce(async (_uid, id, doc) => {
      rows.set(id, { listingId: id, ...doc, createdAt: new Date(NOW.getTime() - 1000) });
      return false;
    });
    const result = await addFavorite("uid-1", "abcd2345", NOW);
    expect(result).toMatchObject({ created: false, favorite: { createdAt: new Date(NOW.getTime() - 1000).toISOString(), available: true } });
  });
});

describe("removeFavorite", () => {
  it("is idempotent", async () => {
    await addFavorite("uid-1", "abcd2345", NOW);
    await removeFavorite("uid-1", "abcd2345");
    await removeFavorite("uid-1", "abcd2345");
    expect(rows.size).toBe(0);
  });
});

describe("favoritesPage", () => {
  it("serves live cards, the snapshot of a listing gone, and a cursor past the page size", async () => {
    await addFavorite("uid-1", "abcd2345", new Date(NOW.getTime() - 2000));
    await addFavorite("uid-1", "efgh2345", NOW);
    await engine.upsert([doc("efgh2345", "Vélo repeint")]);
    await engine.remove(["abcd2345"]);
    const page = await favoritesPage("uid-1", undefined, NOW);
    expect(page.total).toBe(2);
    expect(page.next).toBeUndefined();
    expect(page.favorites.map((favorite) => [favorite.listingId, favorite.available, favorite.card.title])).toEqual([
      ["efgh2345", true, "Vélo repeint"],
      ["abcd2345", false, "Vélo abcd2345"],
    ]);

    for (let index = 0; index < FAVORITES_PAGE_SIZE; index += 1) {
      rows.set(`m${index}`, { listingId: `m${index}`, createdAt: new Date(NOW.getTime() - 10_000 - index), listingSnapshot: SNAPSHOT });
    }
    expect((await favoritesPage("uid-1", undefined, NOW)).next).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("keeps the snapshots available with the engine down, and refuses a forged cursor", async () => {
    await addFavorite("uid-1", "abcd2345", NOW);
    setSearchEngineForTests({ search: async () => Promise.reject(new SearchUnavailableError()) } as unknown as SearchEngine);
    const page = await favoritesPage("uid-1", undefined, NOW);
    expect(page.favorites[0]).toMatchObject({ listingId: "abcd2345", available: true, card: { title: "Vélo abcd2345" } });
    await expect(favoritesPage("uid-1", "forged", NOW)).rejects.toMatchObject({ status: 400, code: "invalid_body" });
  });
});
