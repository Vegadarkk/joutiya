import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSearchDoc } from "@/lib/db/schemas";
import type { SavedSearchRecord } from "@/lib/saved-searches/repository";
import { SearchUnavailableError, type SearchResponse } from "@/lib/search/types";

// D18 service rules: canonical stored parameters (no page), a blank search refused, the name
// fallback, the alert cursor at the newest matching listing (save time with the engine down),
// repository errors mapped to 409, and an alert switched back on starting after now.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/search/service", () => ({ runSearch: vi.fn() }));

let stored: SavedSearchRecord | null;
vi.mock("@/lib/saved-searches/repository", async () => {
  class SavedSearchLimitError extends Error {}
  class SavedSearchExistsError extends Error {
    constructor(readonly id: string) {
      super("exists");
    }
  }
  return {
    SavedSearchLimitError,
    SavedSearchExistsError,
    listSavedSearches: vi.fn(async () => (stored ? [stored] : [])),
    createSavedSearch: vi.fn(async (_uid: string, doc: SavedSearchDoc) => ({ id: "AbCdEfGhIjKlMnOpQrSt", ...doc })),
    updateSavedSearch: vi.fn(async (_uid: string, _id: string, change: (current: SavedSearchRecord) => Partial<SavedSearchDoc> | null) => {
      if (!stored) return null;
      stored = { ...stored, ...change(stored) };
      return stored;
    }),
    deleteSavedSearch: vi.fn(async () => stored !== null),
  };
});

const repository = await import("@/lib/saved-searches/repository");
const { runSearch } = await import("@/lib/search/service");
const { DEFAULT_SEARCH_NAME, createSearch, newestSortAt, patchSearch, removeSearch, storedParams } = await import("@/lib/saved-searches/service");

const NOW = new Date("2026-10-16T09:00:00Z");
const NEWEST = Date.parse("2026-10-16T08:30:00Z");

function created(): SavedSearchDoc {
  return vi.mocked(repository.createSavedSearch).mock.calls.at(-1)![1];
}

beforeEach(() => {
  stored = null;
  vi.mocked(repository.createSavedSearch).mockClear();
  vi.mocked(runSearch)
    .mockReset()
    .mockResolvedValue({ hits: [{ sortAt: new Date(NEWEST).toISOString() }] } as unknown as SearchResponse);
});

describe("storedParams", () => {
  it("drops the page and keeps the canonical whitelist", () => {
    expect(storedParams({ q: "velo", page: 3, subcategory: "velos", category: "vehicules" })).toEqual({ q: "velo", subcategory: "velos", category: "vehicules" });
  });
});

describe("createSearch", () => {
  it("names the search after its words or the default, alert cursor at the newest match", async () => {
    const view = await createSearch("uid-1", { params: { q: "vélo électrique", page: 2 } as never, alert: "daily" }, NOW);
    expect(view).toMatchObject({ id: "AbCdEfGhIjKlMnOpQrSt", name: "vélo électrique", alert: "daily", createdAt: NOW.toISOString() });
    expect(created()).toMatchObject({ lastNotifiedSortAt: NEWEST, createdAt: NOW, updatedAt: NOW });
    expect(created().params).not.toHaveProperty("page");
    expect(vi.mocked(runSearch).mock.calls[0]).toEqual([{ q: "vélo électrique", sort: "recent" }, { hitsPerPage: 1, featured: false, facets: false, approximate: false, now: NOW }]);

    await createSearch("uid-1", { params: { subcategory: "velos" }, alert: "none" }, NOW);
    expect(created()).toMatchObject({ name: DEFAULT_SEARCH_NAME, alert: "none" });
    await createSearch("uid-1", { name: "Mon vélo", params: { q: "velo" }, alert: "daily" }, NOW);
    expect(created().name).toBe("Mon vélo");
  });

  it("refuses a blank search", async () => {
    await expect(createSearch("uid-1", { params: { sort: "price_asc" }, alert: "daily" }, NOW)).rejects.toMatchObject({ status: 400, code: "invalid_body", details: [{ path: "params", code: "too_small" }] });
    expect(repository.createSavedSearch).not.toHaveBeenCalled();
  });

  it("maps a duplicate and the cap to 409", async () => {
    vi.mocked(repository.createSavedSearch).mockRejectedValueOnce(new repository.SavedSearchExistsError("ZyXwVuTsRqPoNmLkJiHg"));
    await expect(createSearch("uid-1", { params: { q: "velo" }, alert: "daily" }, NOW)).rejects.toMatchObject({ status: 409, code: "saved_search_exists", details: { id: "ZyXwVuTsRqPoNmLkJiHg" } });
    vi.mocked(repository.createSavedSearch).mockRejectedValueOnce(new repository.SavedSearchLimitError());
    await expect(createSearch("uid-1", { params: { q: "velo" }, alert: "daily" }, NOW)).rejects.toMatchObject({ status: 409, code: "saved_search_limit" });
  });
});

describe("newestSortAt", () => {
  it("is 0 without a match and the save time with the engine down", async () => {
    vi.mocked(runSearch).mockResolvedValueOnce({ hits: [] } as unknown as SearchResponse);
    expect(await newestSortAt({ q: "introuvable" }, NOW)).toBe(0);
    vi.mocked(runSearch).mockRejectedValueOnce(new SearchUnavailableError());
    expect(await newestSortAt({ q: "velo" }, NOW)).toBe(NOW.getTime());
    vi.mocked(runSearch).mockRejectedValueOnce(new Error("bug"));
    await expect(newestSortAt({ q: "velo" }, NOW)).rejects.toThrow("bug");
  });
});

describe("patchSearch and removeSearch", () => {
  const base = (): SavedSearchRecord => ({ id: "AbCdEfGhIjKlMnOpQrSt", name: "Vélos", params: { q: "velo" }, alert: "none", lastNotifiedSortAt: NOW.getTime() - 86_400_000 * 20, createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z") });

  it("renames, and starts a re-enabled alert after now (no backlog)", async () => {
    stored = base();
    expect(await patchSearch("uid-1", stored.id, { name: "Vélos de ville" }, NOW)).toMatchObject({ name: "Vélos de ville", alert: "none" });
    expect(stored.lastNotifiedSortAt).toBe(NOW.getTime() - 86_400_000 * 20);
    await patchSearch("uid-1", stored.id, { alert: "daily" }, NOW);
    expect(stored).toMatchObject({ alert: "daily", lastNotifiedSortAt: NOW.getTime(), updatedAt: NOW });
    // Already on: the cursor stays.
    await patchSearch("uid-1", stored.id, { alert: "daily" }, new Date(NOW.getTime() + 60_000));
    expect(stored.lastNotifiedSortAt).toBe(NOW.getTime());
  });

  it("answers 404 for a missing search", async () => {
    await expect(patchSearch("uid-1", "AbCdEfGhIjKlMnOpQrSt", { name: "x" }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(removeSearch("uid-1", "AbCdEfGhIjKlMnOpQrSt")).rejects.toMatchObject({ status: 404 });
    stored = base();
    await expect(removeSearch("uid-1", stored.id)).resolves.toBeUndefined();
  });
});
