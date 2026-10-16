import { beforeEach, describe, expect, it, vi } from "vitest";
import { cityBySlug } from "@/config/regions";
import { SEARCH_MAX_PAGE, SEARCH_PAGE_SIZE, parseSearchParams, searchPath, type SearchParams } from "@/lib/search/params";
import { SearchUnavailableError, type CardDocument, type EngineQuery, type EngineResult } from "@/lib/search/types";

// Search service (design D5-D8) against a scripted engine: the filter of every parameter, the sort
// mapping, page mode and its cap, the approximate retry, facets, and the À la Une query sent in the
// same round trip as the results on page 1.

const engine = vi.hoisted(() => ({
  search: vi.fn<(queries: EngineQuery[]) => Promise<EngineResult[]>>(),
}));

vi.mock("@/lib/search/engine", () => ({ searchEngine: () => ({ kind: "memory", search: engine.search }) }));
vi.mock("@/lib/search/normalize", () => ({ normalizeQuery: (q: string) => q.trim().replace(/\s+/g, " ").toLowerCase() }));

import { buildFilter, facetFields, featuredFilter, featuredListings, latestListings, runSearch, sortSpecs } from "@/lib/search/service";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const casablanca = cityBySlug("casablanca")!;

function card(id: string, overrides: Partial<CardDocument> = {}): CardDocument {
  return {
    id,
    slugId: `annonce-${id}`,
    title: `Annonce ${id}`,
    subcategoryId: "velos",
    price: 100,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photoCount: 0,
    sellerType: "individual",
    sortAt: NOW.getTime() - 1000,
    isBumped: false,
    ...overrides,
  };
}

function result(hits: CardDocument[], overrides: Partial<EngineResult> = {}): EngineResult {
  return { hits, totalHits: hits.length, totalPages: hits.length ? 1 : 0, page: 1, processingTimeMs: 1, ...overrides };
}

/** Each engine.search call answers one result per query, from `script` in call order. */
function script(...calls: EngineResult[][]): void {
  for (const call of calls) engine.search.mockResolvedValueOnce(call);
}

const queriesOf = (call: number): EngineQuery[] => engine.search.mock.calls[call]?.[0] ?? [];

beforeEach(() => {
  engine.search.mockReset();
});

describe("buildFilter", () => {
  const filter = (params: SearchParams) => buildFilter(params, NOW);

  it("is undefined for a blank search and unwrapped for a single clause", () => {
    expect(filter({})).toBeUndefined();
    expect(filter({ q: "velo", sort: "price_asc", page: 3 })).toBeUndefined();
    expect(filter({ category: "vehicules" })).toEqual({ field: "categoryId", op: "eq", value: "vehicules" });
  });

  it("filters on the subcategory and its category", () => {
    expect(filter({ subcategory: "velos" })).toEqual({
      and: [
        { field: "categoryId", op: "eq", value: "vehicules" },
        { field: "subcategoryId", op: "eq", value: "velos" },
      ],
    });
  });

  it("filters a region, or a city instead of its region", () => {
    expect(filter({ region: "06" })).toEqual({ field: "regionCode", op: "eq", value: "06" });
    expect(filter({ city: "casablanca" })).toEqual({ field: "citySlug", op: "eq", value: "casablanca" });
  });

  it("replaces the city by a radius around its centroid", () => {
    expect(filter({ city: "casablanca", radiusKm: 20 })).toEqual({ geoRadius: { lat: casablanca.lat, lng: casablanca.lng, meters: 20_000 } });
  });

  it("filters a district only within a city and without radius", () => {
    expect(filter({ city: "casablanca", district: "maarif" })).toEqual({
      and: [
        { field: "citySlug", op: "eq", value: "casablanca" },
        { field: "district", op: "eq", value: "maarif" },
      ],
    });
    expect(filter({ district: "maarif" })).toBeUndefined();
    expect(filter({ city: "casablanca", radiusKm: 10, district: "maarif" })).toEqual({ geoRadius: { lat: casablanca.lat, lng: casablanca.lng, meters: 10_000 } });
  });

  it("filters price bounds (ordered) and drops unknown places", () => {
    expect(filter({ priceMin: 100, priceMax: 50 })).toEqual({
      and: [
        { field: "price", op: "gte", value: 50 },
        { field: "price", op: "lte", value: 100 },
      ],
    });
    expect(filter({ priceMax: 0 })).toEqual({ field: "price", op: "lte", value: 0 });
    expect(filter({ city: "atlantis", region: "99" })).toBeUndefined();
  });

  it("filters sellers, shops, donations, photos and conditions", () => {
    expect(filter({ sellerType: "individual" })).toEqual({ field: "sellerType", op: "eq", value: "individual" });
    expect(filter({ sellerId: "abcdefghjk" })).toEqual({ field: "sellerPublicId", op: "eq", value: "abcdefghjk" });
    expect(filter({ shop: "abcdefghjk" })).toEqual({
      and: [
        { field: "sellerType", op: "eq", value: "pro" },
        { field: "sellerPublicId", op: "eq", value: "abcdefghjk" },
      ],
    });
    expect(filter({ donation: true })).toEqual({ field: "isDonation", op: "eq", value: true });
    expect(filter({ withPhoto: true })).toEqual({ field: "hasPhoto", op: "eq", value: true });
    expect(filter({ conditions: ["good", "new_tagged"] })).toEqual({ field: "condition", op: "in", values: ["new_tagged", "good"] });
  });

  it("lets donations win over price bounds (donations have no price)", () => {
    expect(filter({ donation: true, priceMin: 10, priceMax: 500 })).toEqual({ field: "isDonation", op: "eq", value: true });
    const params = parseSearchParams(new URLSearchParams("don=1&prix-min=0&prix-max=500&tri=prix-croissant"));
    expect(params).toEqual({ donation: true, sort: "price_asc" });
    expect(searchPath({ priceMax: 500, donation: true })).toBe("/recherche?don=1");
  });

  it("filters criteria by kind on their a_* fields, only for the chosen subcategory", () => {
    const params = parseSearchParams(new URLSearchParams("sous-categorie=voitures&f-car-brand=renault,dacia&f-year-min=2015&f-year-max=2020&f-mileage-max=90000"));
    const parts = (filter(params) as { and: unknown[] }).and;
    expect(parts).toContainEqual({ field: "a_car_brand", op: "in", values: expect.arrayContaining(["renault", "dacia"]) });
    expect(parts).toContainEqual({ field: "a_year", op: "gte", value: 2015 });
    expect(parts).toContainEqual({ field: "a_year", op: "lte", value: 2020 });
    expect(parts).toContainEqual({ field: "a_mileage", op: "lte", value: 90000 });
    // Criteria without their subcategory are dropped (canonical parameters).
    expect(filter({ criteria: { year: { kind: "range", min: 2015 } } })).toBeUndefined();
  });

  it("filters boolean criteria as true and multiselect criteria as any of", () => {
    const params = parseSearchParams(new URLSearchParams("sous-categorie=location&f-furnished=1&f-amenities=piscine,parking"));
    const parts = (filter(params) as { and: unknown[] }).and;
    expect(parts).toContainEqual({ field: "a_furnished", op: "eq", value: true });
    expect(parts).toContainEqual({ field: "a_amenities", op: "in", values: ["parking", "piscine"] });
  });

  it("never reads featuredUntil for the main results", () => {
    expect(JSON.stringify(filter({ category: "vehicules", city: "casablanca" }))).not.toContain("featuredUntil");
  });
});

describe("featuredFilter", () => {
  it("keeps the category, subcategory and place scope plus a running boost", () => {
    const params: SearchParams = { subcategory: "velos", city: "casablanca", radiusKm: 50, priceMax: 10, sellerType: "pro", withPhoto: true, q: "x" };
    expect(featuredFilter(params, NOW)).toEqual({
      and: [
        { field: "categoryId", op: "eq", value: "vehicules" },
        { field: "subcategoryId", op: "eq", value: "velos" },
        { geoRadius: { lat: casablanca.lat, lng: casablanca.lng, meters: 50_000 } },
        { field: "featuredUntil", op: "gt", value: NOW.getTime() },
      ],
    });
    expect(featuredFilter({}, NOW)).toEqual({ field: "featuredUntil", op: "gt", value: NOW.getTime() });
  });
});

describe("sortSpecs (D6)", () => {
  it("maps every sort", () => {
    expect(sortSpecs("recent", {})).toEqual([{ field: "sortAt", dir: "desc" }]);
    expect(sortSpecs("relevance", {})).toEqual([]);
    expect(sortSpecs("price_asc", {})).toEqual([{ field: "price", dir: "asc" }]);
    expect(sortSpecs("price_desc", {})).toEqual([{ field: "price", dir: "desc" }]);
    expect(sortSpecs("distance", { city: "casablanca" })).toEqual([
      { geoPoint: { lat: casablanca.lat, lng: casablanca.lng }, dir: "asc" },
      { field: "sortAt", dir: "desc" },
    ]);
    expect(sortSpecs("distance", {})).toEqual([{ field: "sortAt", dir: "desc" }]);
  });
});

describe("facetFields", () => {
  it("asks districts only within one city", () => {
    expect(facetFields({})).toEqual(["categoryId", "subcategoryId"]);
    expect(facetFields({ city: "casablanca" })).toEqual(["categoryId", "subcategoryId", "district"]);
    expect(facetFields({ city: "casablanca", radiusKm: 10 })).toEqual(["categoryId", "subcategoryId"]);
  });
});

describe("runSearch", () => {
  it("sends the results and the À la Une pool in one engine call on page 1", async () => {
    const pool = ["f1", "f2", "f3", "f4"].map((id) => card(id, { featuredUntil: NOW.getTime() + 60_000 }));
    script([result([card("a1"), card("a2")], { facetDistribution: { categoryId: { loisirs: 2, mode: 0 }, subcategoryId: { velos: 2 } } }), result(pool)]);
    const response = await runSearch({ q: "Vélo Rouge", category: "loisirs", priceMax: 500 }, { now: NOW, seed: "s1" });

    expect(engine.search).toHaveBeenCalledTimes(1);
    const [main, featured] = queriesOf(0);
    expect(main).toEqual({
      q: "vélo rouge",
      filter: { and: [{ field: "categoryId", op: "eq", value: "loisirs" }, { field: "price", op: "lte", value: 500 }] },
      sort: [],
      page: 1,
      hitsPerPage: SEARCH_PAGE_SIZE,
      matchingStrategy: "all",
      facets: ["categoryId", "subcategoryId"],
    });
    expect(featured).toEqual({
      q: "",
      filter: { and: [{ field: "categoryId", op: "eq", value: "loisirs" }, { field: "featuredUntil", op: "gt", value: NOW.getTime() }] },
      sort: [{ field: "sortAt", dir: "desc" }],
      page: 1,
      hitsPerPage: 20,
    });

    expect(response).toMatchObject({ params: { q: "Vélo Rouge", category: "loisirs", priceMax: 500 }, sort: "relevance", total: 2, page: 1, totalPages: 1, approximate: false });
    expect(response.hits.map((hit) => [hit.id, hit.featured])).toEqual([
      ["a1", false],
      ["a2", false],
    ]);
    expect(response.featured).toHaveLength(2);
    expect(response.featured.every((hit) => hit.featured)).toBe(true);
    expect(response.facets).toEqual({ categories: { loisirs: 2 }, subcategories: { velos: 2 } });
    expect(response.tookMs).toBeGreaterThanOrEqual(0);

    // Same seed, same draw.
    script([result([card("b1")]), result(pool)]);
    const again = await runSearch({ q: "Vélo Rouge", category: "loisirs", priceMax: 500 }, { now: NOW, seed: "s1" });
    expect(again.featured.map((hit) => hit.id)).toEqual(response.featured.map((hit) => hit.id));
  });

  it("asks no À la Une pool after page 1 or when disabled", async () => {
    script([result([], { page: 2 })]);
    const second = await runSearch({ category: "mode", page: 2 }, { now: NOW });
    expect(queriesOf(0)).toHaveLength(1);
    expect(queriesOf(0)[0]).toMatchObject({ page: 2, sort: [{ field: "sortAt", dir: "desc" }] });
    expect(second.featured).toEqual([]);

    script([result([])]);
    await runSearch({}, { featured: false, now: NOW });
    expect(queriesOf(1)).toHaveLength(1);
  });

  it("caps pages at SEARCH_MAX_PAGE", async () => {
    script([result([card("x")], { totalHits: 1200, totalPages: 80 })]);
    const response = await runSearch({ page: 7 }, { featured: false, now: NOW });
    expect(response).toMatchObject({ page: 7, totalPages: SEARCH_MAX_PAGE, total: 1200 });
    expect(queriesOf(0)[0]).toMatchObject({ page: 7, hitsPerPage: SEARCH_PAGE_SIZE });

    // A page beyond the cap is page 1 (canonical parameters), never an engine error.
    script([result([]), result([])]);
    expect((await runSearch({ page: SEARCH_MAX_PAGE + 10 }, { now: NOW })).page).toBe(1);
    expect(queriesOf(1)[0]?.page).toBe(1);
  });

  it("bounds hitsPerPage", async () => {
    script([result([])], [result([])]);
    await runSearch({}, { featured: false, hitsPerPage: 5000 });
    await runSearch({}, { featured: false, hitsPerPage: 0 });
    expect(queriesOf(0)[0]?.hitsPerPage).toBe(100);
    expect(queriesOf(1)[0]?.hitsPerPage).toBe(1);
  });

  it("retries once with matchingStrategy last when every word finds nothing", async () => {
    script([result([]), result([])], [result([card("p1")], { facetDistribution: { categoryId: { maison: 1 } } })]);
    const response = await runSearch({ q: "canapé cuir rouge" }, { now: NOW });
    expect(engine.search).toHaveBeenCalledTimes(2);
    expect(queriesOf(1)).toEqual([{ ...queriesOf(0)[0], matchingStrategy: "last" }]);
    expect(response).toMatchObject({ approximate: true, total: 1, facets: { categories: { maison: 1 }, subcategories: {} } });
    expect(response.hits.map((hit) => hit.id)).toEqual(["p1"]);
  });

  it("skips the retry when approximate results are not wanted", async () => {
    script([result([])]);
    const response = await runSearch({ q: "canapé cuir rouge" }, { featured: false, approximate: false, now: NOW });
    expect(engine.search).toHaveBeenCalledTimes(1);
    expect(queriesOf(0)[0]?.matchingStrategy).toBe("all");
    expect(response).toMatchObject({ approximate: false, total: 0, hits: [] });
  });

  it("does not retry a single word, a match, or report an empty retry as approximate", async () => {
    script([result([]), result([])]);
    expect((await runSearch({ q: "canapé" }, { now: NOW })).approximate).toBe(false);
    expect(engine.search).toHaveBeenCalledTimes(1);

    engine.search.mockReset();
    script([result([card("a")]), result([])]);
    expect((await runSearch({ q: "canapé cuir" }, { now: NOW })).approximate).toBe(false);
    expect(engine.search).toHaveBeenCalledTimes(1);

    engine.search.mockReset();
    script([result([]), result([])], [result([])]);
    expect(await runSearch({ q: "zzz yyy" }, { now: NOW })).toMatchObject({ approximate: false, total: 0, hits: [] });
    expect(engine.search).toHaveBeenCalledTimes(2);
  });

  it("decides the retry on totalHits, not on an empty later page", async () => {
    script([result([], { totalHits: 30, totalPages: 2, page: 3 })]);
    expect((await runSearch({ q: "deux mots", page: 3 }, { now: NOW })).approximate).toBe(false);
    expect(engine.search).toHaveBeenCalledTimes(1);
  });

  it("maps the sort and the district facet of a city search", async () => {
    script([result([], { facetDistribution: { district: { maarif: 3, gauthier: 0 } } }), result([])]);
    const response = await runSearch({ city: "casablanca", sort: "price_desc" }, { now: NOW });
    expect(queriesOf(0)[0]).toMatchObject({ sort: [{ field: "price", dir: "desc" }], facets: ["categoryId", "subcategoryId", "district"] });
    expect(response.sort).toBe("price_desc");
    expect(response.facets.districts).toEqual({ maarif: 3 });
  });

  it("counts the other districts of the city while one is chosen (D7)", async () => {
    const extra = { field: "sortAt", op: "gt" as const, value: 5 };
    script([
      result([card("d1")], { facetDistribution: { categoryId: { immobilier: 1 }, subcategoryId: { location: 1 } } }),
      result([]),
      result([], { totalHits: 9, totalPages: 0, facetDistribution: { district: { maarif: 1, gauthier: 8, oasis: 0 } } }),
    ]);
    const response = await runSearch({ q: "studio", city: "casablanca", district: "maarif" }, { now: NOW, extraFilter: extra });
    expect(engine.search).toHaveBeenCalledTimes(1);
    const [main, featured, districts] = queriesOf(0);
    expect(main?.facets).toEqual(["categoryId", "subcategoryId"]);
    expect(main?.filter).toEqual({ and: [{ and: [{ field: "citySlug", op: "eq", value: "casablanca" }, { field: "district", op: "eq", value: "maarif" }] }, extra] });
    expect(featured?.filter).toMatchObject({ and: [{ field: "citySlug", op: "eq", value: "casablanca" }, { field: "featuredUntil", op: "gt" }] });
    expect(districts).toEqual({ q: "studio", filter: { and: [{ field: "citySlug", op: "eq", value: "casablanca" }, extra] }, page: 1, hitsPerPage: 0, matchingStrategy: "all", facets: ["district"] });
    expect(response.facets).toEqual({ categories: { immobilier: 1 }, subcategories: { location: 1 }, districts: { maarif: 1, gauthier: 8 } });
    expect(response).toMatchObject({ total: 1, params: { district: "maarif" } });

    // Without À la Une, and with the approximate retry: the district counts follow the retry.
    script([result([]), result([], { facetDistribution: { district: { gauthier: 2 } } })], [result([card("p1")]), result([], { facetDistribution: { district: { maarif: 1, gauthier: 5 } } })]);
    const retried = await runSearch({ q: "studio meublé", city: "casablanca", district: "maarif" }, { featured: false, now: NOW });
    expect(queriesOf(1)).toHaveLength(2);
    expect(queriesOf(2).map((query) => query.matchingStrategy)).toEqual(["last", "last"]);
    expect(queriesOf(2)[1]).toMatchObject({ hitsPerPage: 0, facets: ["district"] });
    expect(retried).toMatchObject({ approximate: true, facets: { districts: { maarif: 1, gauthier: 5 } } });
  });

  it("asks no facets when disabled and ANDs an extra filter", async () => {
    script([result([])]);
    const extra = { field: "sortAt", op: "gt" as const, value: 5 };
    await runSearch({ category: "mode" }, { featured: false, facets: false, extraFilter: extra });
    const [main] = queriesOf(0);
    expect(main).not.toHaveProperty("facets");
    expect(main?.filter).toEqual({ and: [{ field: "categoryId", op: "eq", value: "mode" }, extra] });

    script([result([])]);
    await runSearch({}, { featured: false, extraFilter: extra });
    expect(queriesOf(1)[0]?.filter).toEqual(extra);
  });

  it("lets SearchUnavailableError through", async () => {
    engine.search.mockRejectedValueOnce(new SearchUnavailableError());
    await expect(runSearch({})).rejects.toBeInstanceOf(SearchUnavailableError);
    engine.search.mockResolvedValueOnce([]);
    await expect(runSearch({})).rejects.toBeInstanceOf(SearchUnavailableError);
  });
});

describe("latestListings", () => {
  it("asks the newest cards of a scope, without facets or À la Une", async () => {
    script([result([card("n1"), card("n2")])]);
    const cards = await latestListings({ category: "mode", sort: "price_asc", page: 4 }, 12);
    expect(cards.map((hit) => hit.id)).toEqual(["n1", "n2"]);
    expect(queriesOf(0)).toHaveLength(1);
    expect(queriesOf(0)[0]).toMatchObject({ page: 1, hitsPerPage: 12, sort: [{ field: "sortAt", dir: "desc" }] });
    expect(queriesOf(0)[0]).not.toHaveProperty("facets");
  });
});

describe("featuredListings", () => {
  it("draws `count` cards of the scope's pool, marked featured", async () => {
    const until = Date.now() + 3_600_000;
    const pool = Array.from({ length: 12 }, (_, i) => card(`f${i}`, { featuredUntil: until }));
    script([result(pool)], [result(pool)]);
    const first = await featuredListings({ city: "casablanca" }, 8, "home");
    const second = await featuredListings({ city: "casablanca" }, 8, "home");
    expect(first).toHaveLength(8);
    expect(first.every((hit) => hit.featured)).toBe(true);
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id));
    expect(queriesOf(0)[0]?.filter).toMatchObject({ and: [{ field: "citySlug", op: "eq", value: "casablanca" }, { field: "featuredUntil", op: "gt" }] });
  });
});
