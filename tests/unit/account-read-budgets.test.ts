import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS, type RateLimitDefinition, type RateLimitId } from "@/config/rate-limits";
import { FAVORITES_PAGE_SIZE } from "@/lib/contracts/search";
import type { FavoriteSnapshot } from "@/lib/db/schemas";
import type { FavoriteRecord } from "@/lib/favorites/repository";
import { setFavoriteCacheClientForTests } from "@/lib/favorites/ids-cache";
import { resetServerEnv } from "@/lib/env";
import { consumeLimit, limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";
import type { SavedSearchRecord } from "@/lib/saved-searches/repository";
import { setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";

// Phase 4 account routes against the Spark day (50 000 reads, 20 000 writes, 20 000 deletes for
// the whole site): favorites and saved-search reads are charged in documents on a daily budget
// per account, like listing.owner.read.uid (one point before the read, so a spent budget reads
// nothing), and their writes are counted per day. Firestore is replaced by in-memory repositories,
// Valkey is off (the hearts come from the subcollection), the limiter runs in memory.

const HOUR = 3600;
const DAY = 24 * HOUR;

const viewer = vi.hoisted(() => ({ uid: "uid-budget" }));
vi.mock("@/lib/auth/guards", () => ({ requireUser: vi.fn(async () => ({ user: { uid: viewer.uid } })) }));
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/search/service", () => ({ runSearch: vi.fn() }));

let favorites: FavoriteRecord[];
vi.mock("@/lib/favorites/repository", () => ({
  getFavorite: vi.fn(async () => null),
  createFavorite: vi.fn(async () => true),
  deleteFavorite: vi.fn(async () => true),
  listFavoriteIds: vi.fn(async (_uid: string, limit: number) => favorites.slice(0, limit).map((favorite) => favorite.listingId)),
  // Newest first; one more than the page tells that another page follows (the repository reads limit + 1).
  listFavoritesPage: vi.fn(async (_uid: string, limit: number) => {
    const page = favorites.slice(0, limit);
    const last = page[page.length - 1];
    return { favorites: page, ...(favorites.length > limit && last ? { next: { at: last.createdAt, id: last.listingId } } : {}) };
  }),
}));

let searches: SavedSearchRecord[];
vi.mock("@/lib/saved-searches/repository", () => ({
  SavedSearchLimitError: class extends Error {},
  SavedSearchExistsError: class extends Error {},
  listSavedSearches: vi.fn(async () => searches),
  createSavedSearch: vi.fn(),
  updateSavedSearch: vi.fn(),
  deleteSavedSearch: vi.fn(),
}));

const favoritesRepository = await import("@/lib/favorites/repository");
const savedSearchesRepository = await import("@/lib/saved-searches/repository");
const { handleFavoriteIds, handleFavorites } = await import("@/lib/favorites/handlers");
const { handleListSearches } = await import("@/lib/saved-searches/handlers");

const SNAPSHOT: FavoriteSnapshot = { slugId: "velo-abcd2345", title: "Vélo", subcategoryId: "velos", price: 900, priceNegotiable: false, isDonation: false, citySlug: "rabat", photo: null, photoCount: 0, sellerType: "individual" };
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function favoriteRows(count: number): FavoriteRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    listingId: `s${ALPHABET[Math.floor(index / ALPHABET.length) % ALPHABET.length]}${ALPHABET[index % ALPHABET.length]}bcd234`,
    createdAt: new Date(Date.UTC(2026, 9, 16) - index * 60_000),
    listingSnapshot: SNAPSHOT,
  }));
}

function searchRows(count: number): SavedSearchRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `search${index}`.padEnd(20, "x"),
    name: `Vélo ${index}`,
    params: { q: `velo ${index}` },
    alert: "daily",
    lastNotifiedSortAt: 0,
    createdAt: new Date(Date.UTC(2026, 9, 16) - index * 60_000),
    updatedAt: new Date(Date.UTC(2026, 9, 16)),
  }));
}

const get = (path: string) => new Request(`http://localhost:3000${path}`);
const charged = async (id: RateLimitId) => (await limitState(id, viewer.uid))?.consumedPoints ?? 0;
const spendAll = async (id: RateLimitId) => expect((await consumeLimit(id, viewer.uid, RATE_LIMITS[id].points - (await charged(id)))).ok).toBe(true);

let accounts = 0;
beforeEach(() => {
  delete process.env.RATE_LIMIT_REDIS_URL;
  resetServerEnv();
  resetRateLimiters();
  setFavoriteCacheClientForTests(null);
  setSearchEngineForTests(new MemoryEngine());
  viewer.uid = `uid-budget-${++accounts}`;
  favorites = [];
  searches = [];
  vi.mocked(favoritesRepository.listFavoritesPage).mockClear();
  vi.mocked(favoritesRepository.listFavoriteIds).mockClear();
  vi.mocked(savedSearchesRepository.listSavedSearches).mockClear();
});

afterAll(() => {
  setFavoriteCacheClientForTests(undefined);
  setSearchEngineForTests(null);
});

describe("phase 4 account limiters", () => {
  it("counts favorites and saved-search writes per day, and reads in documents per day", () => {
    const expected: Record<string, RateLimitDefinition> = {
      "favorites.write.uid": { points: 300, duration: DAY, policy: "open", key: "uid" },
      "favorites.read.uid": { points: 1200, duration: HOUR, policy: "open", key: "uid" },
      "favorites.docs.uid": { points: 2500, duration: DAY, policy: "open", key: "uid" },
      "savedSearch.write.uid": { points: 100, duration: DAY, policy: "open", key: "uid" },
      "savedSearch.read.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
      "savedSearch.docs.uid": { points: 1000, duration: DAY, policy: "open", key: "uid" },
    };
    for (const [id, definition] of Object.entries(expected)) expect(RATE_LIMITS[id as RateLimitId], id).toEqual(definition);
  });
});

describe("GET /api/favorites", () => {
  it("charges the documents read: a full page and its look-ahead, plus the hearts rebuild", async () => {
    favorites = favoriteRows(FAVORITES_PAGE_SIZE + 12);
    const response = await handleFavorites(get("/api/favorites"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { favorites: unknown[]; next?: string };
    expect(body.favorites).toHaveLength(FAVORITES_PAGE_SIZE);
    expect(body.next).toBeDefined();
    // 49 for the page (48 + the one telling a page follows), 60 for the ids (no Valkey: rebuilt).
    expect(await charged("favorites.docs.uid")).toBe(FAVORITES_PAGE_SIZE + 1 + favorites.length);
  });

  it("charges one document for an empty list (Firestore bills an empty query one read)", async () => {
    expect((await handleFavorites(get("/api/favorites"))).status).toBe(200);
    // The page's point, then the ids rebuild's point.
    expect(await charged("favorites.docs.uid")).toBe(2);
  });

  it("refuses with 429 before any read once the day's documents are spent", async () => {
    favorites = favoriteRows(3);
    await spendAll("favorites.docs.uid");
    await expect(handleFavorites(get("/api/favorites"))).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(favoritesRepository.listFavoritesPage).not.toHaveBeenCalled();
    expect(favoritesRepository.listFavoriteIds).not.toHaveBeenCalled();
  });
});

describe("GET /api/favorites/ids", () => {
  it("charges a rebuild of the hearts set in documents, and stops rebuilding once the day is spent", async () => {
    favorites = favoriteRows(40);
    const response = await handleFavoriteIds(get("/api/favorites/ids"));
    expect(((await response.json()) as { ids: string[] }).ids).toHaveLength(40);
    expect(await charged("favorites.docs.uid")).toBe(40);

    await spendAll("favorites.docs.uid");
    vi.mocked(favoritesRepository.listFavoriteIds).mockClear();
    await expect(handleFavoriteIds(get("/api/favorites/ids"))).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(favoritesRepository.listFavoriteIds).not.toHaveBeenCalled();
  });
});

describe("GET /api/saved-searches", () => {
  it("charges one point per saved search read, one for none", async () => {
    searches = searchRows(10);
    const response = await handleListSearches(get("/api/saved-searches"));
    expect(((await response.json()) as { searches: unknown[] }).searches).toHaveLength(10);
    expect(await charged("savedSearch.docs.uid")).toBe(10);
    searches = [];
    await handleListSearches(get("/api/saved-searches"));
    expect(await charged("savedSearch.docs.uid")).toBe(11);
  });

  it("refuses with 429 before any read once the day's documents are spent", async () => {
    searches = searchRows(2);
    await spendAll("savedSearch.docs.uid");
    await expect(handleListSearches(get("/api/saved-searches"))).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(savedSearchesRepository.listSavedSearches).not.toHaveBeenCalled();
  });
});
