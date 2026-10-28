import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayNumber } from "@/lib/listings/rental-availability";
import { canonicalSearchParams, defaultSort, parseSearchParams, rentalDuration, searchPath, storedSearchParamsSchema } from "@/lib/search/params";
import type { CardDocument, EngineQuery, EngineResult, FilterExpr } from "@/lib/search/types";

// Car rental search by dates (rental pack §4): the du/au parameters, the availability filter, the
// up-to-date listings first then the ones to confirm (owner decision 4), and the cards' estimate.

const engine = vi.hoisted(() => ({
  search: vi.fn<(queries: EngineQuery[]) => Promise<EngineResult[]>>(),
}));

vi.mock("@/lib/search/engine", () => ({ searchEngine: () => ({ kind: "memory", search: engine.search }) }));

import { toSearchCard } from "@/lib/search/cards";
import { activeRentalDates, buildFilter, rentalFreshFilter, runSearch } from "@/lib/search/service";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const RENTAL = "sous-categorie=location-voitures";
const DATES = { from: "2026-10-20", to: "2026-10-23" };
const url = (query: string) => parseSearchParams(new URLSearchParams(query));

function rental(id: string, overrides: Partial<CardDocument> = {}): CardDocument {
  return {
    id,
    slugId: `dacia-logan-${id}`,
    title: `Dacia Logan ${id}`,
    subcategoryId: "location-voitures",
    price: 300,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photoCount: 1,
    sellerType: "pro",
    sortAt: NOW.getTime() - 1000,
    isBumped: false,
    ...overrides,
  };
}

const ids = (prefix: string, count: number, offset = 0) => Array.from({ length: count }, (_, index) => rental(`${prefix}${index + offset}`));

function result(hits: CardDocument[], totalHits = hits.length, facetDistribution?: EngineResult["facetDistribution"]): EngineResult {
  return { hits, totalHits, totalPages: 1, page: 1, processingTimeMs: 1, ...(facetDistribution ? { facetDistribution } : {}) };
}

const queriesOf = (call: number): EngineQuery[] => engine.search.mock.calls[call]?.[0] ?? [];
const fresh = rentalFreshFilter(NOW);

beforeEach(() => {
  engine.search.mockReset();
});

describe("rental dates parameters", () => {
  it("reads du/au for car rentals only, ordered and at most 60 days apart", () => {
    expect(url(`${RENTAL}&du=2026-10-20&au=2026-10-23`).dates).toEqual(DATES);
    expect(url(`${RENTAL}&du=2026-10-20&au=2026-10-20`).dates).toEqual({ from: "2026-10-20", to: "2026-10-20" });
    expect(url(`${RENTAL}&du=2026-10-23&au=2026-10-20`).dates).toBeUndefined();
    expect(url(`${RENTAL}&du=2026-10-20&au=2026-12-20`).dates).toBeUndefined();
    expect(url(`${RENTAL}&du=2026-02-30&au=2026-03-02`).dates).toBeUndefined();
    expect(url(`${RENTAL}&du=2026-10-20`).dates).toBeUndefined();
    expect(url("sous-categorie=voitures&du=2026-10-20&au=2026-10-23").dates).toBeUndefined();
  });

  it("round-trips through the URL and sorts by day price by default", () => {
    const params = url(`${RENTAL}&du=2026-10-20&au=2026-10-23`);
    expect(searchPath(params)).toContain("du=2026-10-20&au=2026-10-23");
    expect(url(searchPath(params).split("?")[1] ?? "")).toEqual(params);
    expect(defaultSort(params)).toBe("price_asc");
    expect(canonicalSearchParams({ ...params, sort: "price_asc" }).sort).toBeUndefined();
    expect(canonicalSearchParams({ subcategory: "voitures", dates: DATES }).dates).toBeUndefined();
    expect(storedSearchParamsSchema.safeParse({ subcategory: "location-voitures", dates: DATES }).success).toBe(true);
  });

  it("counts rental days as return minus pick-up, at least one", () => {
    expect(rentalDuration(DATES)).toBe(3);
    expect(rentalDuration({ from: "2026-10-20", to: "2026-10-20" })).toBe(1);
  });
});

describe("rental dates filter", () => {
  it("applies a pick-up from today to 180 days ahead only", () => {
    expect(activeRentalDates({ dates: { from: "2026-10-16", to: "2026-10-17" } }, NOW)).toBeDefined();
    expect(activeRentalDates({ dates: { from: "2026-10-15", to: "2026-10-17" } }, NOW)).toBeUndefined();
    expect(activeRentalDates({ dates: { from: "2027-04-14", to: "2027-04-15" } }, NOW)).toBeDefined();
    expect(activeRentalDates({ dates: { from: "2027-04-15", to: "2027-04-16" } }, NOW)).toBeUndefined();
  });

  it("keeps rentals free on every day, pick-up and return included, whose minimum fits", () => {
    const from = dayNumber(DATES.from);
    const filter = buildFilter({ subcategory: "location-voitures", dates: DATES, includeSoldOut: true }, NOW) as { and: FilterExpr[] };
    expect(filter.and.at(-1)).toEqual({
      and: [
        { not: { field: "rentUnavailableDays", op: "in", values: [from, from + 1, from + 2, from + 3] } },
        { or: [{ field: "a_min_rental_days", op: "lte", value: 3 }, { not: { field: "a_min_rental_days", op: "exists" } }] },
      ],
    });
    // Past dates (a stale link) do not filter.
    expect(buildFilter({ subcategory: "location-voitures", dates: { from: "2026-10-01", to: "2026-10-03" }, includeSoldOut: true }, NOW)).toEqual({
      and: [
        { field: "categoryId", op: "eq", value: "vehicules" },
        { field: "subcategoryId", op: "eq", value: "location-voitures" },
      ],
    });
  });
});

describe("runSearch by rental dates", () => {
  const search = (page = 1) => runSearch({ subcategory: "location-voitures", dates: DATES, page }, { now: NOW, featured: false, hitsPerPage: 4 });

  it("asks the up-to-date page and counts the others in one call, facets and totals summed", async () => {
    engine.search.mockResolvedValueOnce([
      result(ids("f", 4), 6, { categoryId: { vehicules: 6 }, subcategoryId: { "location-voitures": 6 } }),
      result([], 3, { categoryId: { vehicules: 3 }, subcategoryId: { "location-voitures": 3 } }),
    ]);
    const response = await search();
    expect(engine.search).toHaveBeenCalledTimes(1);
    const [top, stale] = queriesOf(0);
    expect((top?.filter as { and: FilterExpr[] }).and.at(-1)).toEqual(fresh);
    expect((stale?.filter as { and: FilterExpr[] }).and.at(-1)).toEqual({ not: fresh });
    expect(stale).toMatchObject({ page: 1, hitsPerPage: 0 });
    expect(response).toMatchObject({ sort: "price_asc", total: 9, totalPages: 3 });
    expect(response.facets.subcategories).toEqual({ "location-voitures": 9 });
    expect(response.hits.map((hit) => hit.id)).toEqual(["f0", "f1", "f2", "f3"]);
  });

  it("completes a short page with the first ones to confirm", async () => {
    engine.search.mockResolvedValueOnce([result(ids("f", 2, 4), 6), result([], 3)]).mockResolvedValueOnce([result(ids("s", 3))]);
    const response = await search(2);
    expect(queriesOf(1)).toHaveLength(1);
    expect(queriesOf(1)[0]).toMatchObject({ page: 1, hitsPerPage: 4 });
    expect(queriesOf(1)[0]?.facets).toBeUndefined();
    expect(response.hits.map((hit) => [hit.id, hit.rental?.fresh])).toEqual([
      ["f4", false],
      ["f5", false],
      ["s0", false],
      ["s1", false],
    ]);
  });

  it("continues the ones to confirm across two of their pages", async () => {
    // 6 up to date, page 3 of 4: the others from the 3rd on (skip 2 of their page 1, then page 2).
    engine.search.mockResolvedValueOnce([result([], 6), result([], 9)]).mockResolvedValueOnce([result(ids("s", 4)), result(ids("s", 4, 4))]);
    const response = await search(3);
    expect(queriesOf(1).map((query) => query.page)).toEqual([1, 2]);
    expect(response.hits.map((hit) => hit.id)).toEqual(["s2", "s3", "s4", "s5"]);
  });

  it("sends one query without dates", async () => {
    engine.search.mockResolvedValueOnce([result(ids("a", 2))]);
    const response = await runSearch({ subcategory: "location-voitures" }, { now: NOW, featured: false });
    expect(queriesOf(0)).toHaveLength(1);
    expect(response.hits[0]?.rental).toBeUndefined();
  });
});

describe("rental cards", () => {
  it("estimate the total with the long-term rate and tell the freshness", () => {
    const doc = rental("x", { price: 300, a_rate_7_days: 250, a_rate_30_days: 200, rentFreshUntil: NOW.getTime() + 1 });
    expect(toSearchCard(doc, NOW, false, DATES).rental).toEqual({ days: 3, total: 900, fresh: true });
    expect(toSearchCard(doc, NOW, false, { from: "2026-10-20", to: "2026-10-27" }).rental).toEqual({ days: 7, total: 1750, fresh: true });
    expect(toSearchCard(doc, NOW, false, { from: "2026-10-20", to: "2026-11-19" }).rental).toEqual({ days: 30, total: 6000, fresh: true });
    expect(toSearchCard({ ...doc, rentFreshUntil: NOW.getTime() }, NOW, false, DATES).rental?.fresh).toBe(false);
    expect(toSearchCard(doc, NOW).rental).toBeUndefined();
    expect(toSearchCard({ ...doc, subcategoryId: "voitures" }, NOW, false, DATES).rental).toBeUndefined();
  });
});
