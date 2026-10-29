import "server-only";
import { randomUUID } from "node:crypto";
import { cityBySlug } from "@/config/regions";
import { searchEngine } from "@/lib/search/engine";
import { normalizeQuery } from "@/lib/search/normalize";
import { toSearchCard } from "./cards";
import { FEATURED_POOL_SIZE, FEATURED_SEARCH_SLOTS, drawFeatured } from "./featured";
import { dayNumber, moroccoToday } from "@/lib/listings/rental-availability";
import { RENTAL_SEARCH_AHEAD_DAYS, SEARCH_MAX_PAGE, SEARCH_MAX_TOTAL_HITS, SEARCH_PAGE_SIZE, canonicalSearchParams, effectiveSort, rentalDuration, type RentalDates, type SearchParams, type SearchSort } from "./params";
import { SearchUnavailableError, attributeField, type EngineQuery, type EngineResult, type FilterExpr, type SearchCard, type SearchEngine, type SearchFacets, type SearchResponse, type SortSpec } from "./types";

// Search service (design D5-D8): SearchParams -> engine queries -> cards. Shared by /api/search, the
// /recherche page, the /c pages, the home sections and the saved-search alerts. Engine down or not
// configured: SearchUnavailableError propagates (D2: callers answer 503 or hide the section).

export interface RunSearchOptions {
  /** Page 1 only: draw À la Une cards in the same engine round trip (default true). */
  featured?: boolean;
  /** Category, subcategory and district counts (default true). */
  facets?: boolean;
  /** Default SEARCH_PAGE_SIZE. */
  hitsPerPage?: number;
  /** À la Une draw seed (default: random per call). */
  seed?: string;
  now?: Date;
  /** ANDed with the parameters' filter (alerts: `sortAt > lastNotifiedSortAt`). */
  extraFilter?: FilterExpr;
  /** One "last" retry when every word finds nothing (default true); alerts skip it (exact news only). */
  approximate?: boolean;
}

/** Upper bound of `hitsPerPage` and `limit` arguments. */
export const SEARCH_HITS_MAX = 100;

const FACET_FIELDS = { categories: "categoryId", subcategories: "subcategoryId", districts: "district" } as const;

const eq = (field: string, value: string | number | boolean): FilterExpr => ({ field, op: "eq", value });

function and(parts: (FilterExpr | undefined)[]): FilterExpr | undefined {
  const present = parts.filter((part): part is FilterExpr => part !== undefined);
  if (present.length <= 1) return present[0];
  return { and: present };
}

/**
 * Category, subcategory and place (D7): the scope shared by the results and the À la Une query.
 * City + radius = `_geoRadius` around the city centroid (crosses region borders), city alone =
 * `citySlug` equality, else region.
 */
function scopeFilters(params: SearchParams): FilterExpr[] {
  const parts: FilterExpr[] = [];
  if (params.category) parts.push(eq("categoryId", params.category));
  if (params.subcategory) parts.push(eq("subcategoryId", params.subcategory));
  const city = params.city ? cityBySlug(params.city) : undefined;
  if (city && params.radiusKm) parts.push({ geoRadius: { lat: city.lat, lng: city.lng, meters: params.radiusKm * 1000 } });
  else if (city) parts.push(eq("citySlug", city.slug));
  else if (params.region) parts.push(eq("regionCode", params.region));
  return parts;
}

/**
 * The rental dates a search applies at `now`: a pick-up from today (Morocco) to 180 days ahead;
 * other dates (a stale link, a saved search whose period passed) are ignored.
 */
export function activeRentalDates(params: Pick<SearchParams, "dates">, now: Date): RentalDates | undefined {
  if (!params.dates) return undefined;
  const today = moroccoToday(now);
  const from = dayNumber(params.dates.from);
  return from >= today && from <= today + RENTAL_SEARCH_AHEAD_DAYS ? params.dates : undefined;
}

/**
 * Car rentals free on every day from pick-up to return (rental pack §4) and whose minimum rental
 * fits the duration (none declared = any).
 */
function rentalDatesFilter(dates: RentalDates): FilterExpr {
  const from = dayNumber(dates.from);
  const days = Array.from({ length: dayNumber(dates.to) - from + 1 }, (_, index) => from + index);
  const minDays = attributeField("min-rental-days");
  return {
    and: [
      { not: { field: "rentUnavailableDays", op: "in", values: days } },
      { or: [{ field: minDays, op: "lte", value: rentalDuration(dates) }, { not: { field: minDays, op: "exists" } }] },
    ],
  };
}

/** Availability confirmed within 14 days (rental pack §4, owner decision 4: the others come after). */
export function rentalFreshFilter(now: Date): FilterExpr {
  return { field: "rentFreshUntil", op: "gt", value: now.getTime() };
}

/**
 * Engine filter of a search (every parameter but `q`, `sort` and `page`), or undefined when nothing
 * narrows it. Canonicalizes first, so contradictory input (district without city, criteria of
 * another subcategory) is ignored the way the URL parser ignores it. `now` is the request clock for
 * time-bound filters (rental dates); the main results never read `featuredUntil` (D8).
 */
export function buildFilter(input: SearchParams, now: Date): FilterExpr | undefined {
  const params = canonicalSearchParams(input);
  const parts = scopeFilters(params);
  if (params.district && params.city && !params.radiusKm) parts.push(eq("district", params.district));
  if (params.priceMin !== undefined) parts.push({ field: "price", op: "gte", value: params.priceMin });
  if (params.priceMax !== undefined) parts.push({ field: "price", op: "lte", value: params.priceMax });
  if (params.sellerType) parts.push(eq("sellerType", params.sellerType));
  if (params.sellerId) parts.push(eq("sellerPublicId", params.sellerId));
  if (params.shop) parts.push(eq("sellerPublicId", params.shop));
  if (params.donation) parts.push(eq("isDonation", true));
  if (params.withPhoto) parts.push(eq("hasPhoto", true));
  // Sold-out listings stay online but leave the default results (owner decision 1, 2026-10-28).
  if (!params.includeSoldOut) parts.push({ not: eq("soldOut", true) });
  // Promotions running at `now` (catalogue §4): an ended one is ignored without any rewrite.
  if (params.promo || params.sort === "discount") parts.push(promoRunningFilter(now));
  if (params.conditions?.length) parts.push({ field: "condition", op: "in", values: [...params.conditions] });
  for (const [id, filter] of Object.entries(params.criteria ?? {})) {
    const field = attributeField(id);
    if (filter.kind === "options") parts.push({ field, op: "in", values: [...filter.values] });
    else if (filter.kind === "flag") parts.push(eq(field, true));
    else {
      if (filter.min !== undefined) parts.push({ field, op: "gte", value: filter.min });
      if (filter.max !== undefined) parts.push({ field, op: "lte", value: filter.max });
    }
  }
  const dates = activeRentalDates(params, now);
  if (dates) parts.push(rentalDatesFilter(dates));
  return and(parts);
}

/** A promotion started and not ended at `now`. */
export function promoRunningFilter(now: Date): FilterExpr {
  return { and: [{ field: "promoStartsAt", op: "lte", value: now.getTime() }, { field: "promoEndsAt", op: "gt", value: now.getTime() }] };
}

/** À la Une scope (D8): category, subcategory and place only, boost running at `now`. */
export function featuredFilter(input: SearchParams, now: Date): FilterExpr {
  const running: FilterExpr = { field: "featuredUntil", op: "gt", value: now.getTime() };
  const scope = scopeFilters(canonicalSearchParams(input));
  return scope.length ? { and: [...scope, running] } : running;
}

/**
 * Engine sort of a search sort (D6). Relevance = ranking rules only (their last rule is
 * `sortAt:desc`); date and price sorts sit right after "words" in the rules, so relevance still
 * breaks ties. Distance needs the city (listings share its centroid: newest first among equals).
 */
export function sortSpecs(sort: SearchSort, params: Pick<SearchParams, "city">): SortSpec[] {
  switch (sort) {
    case "relevance":
      return [];
    case "price_asc":
      return [{ field: "price", dir: "asc" }];
    case "price_desc":
      return [{ field: "price", dir: "desc" }];
    case "distance": {
      const city = params.city ? cityBySlug(params.city) : undefined;
      if (city) return [{ geoPoint: { lat: city.lat, lng: city.lng }, dir: "asc" }, { field: "sortAt", dir: "desc" }];
      return [{ field: "sortAt", dir: "desc" }];
    }
    case "recent":
      return [{ field: "sortAt", dir: "desc" }];
    case "discount":
      return [{ field: "promoPercent", dir: "desc" }, { field: "sortAt", dir: "desc" }];
  }
}

/** Facets asked for a search: districts only within one city (no radius: D7). */
export function facetFields(params: Pick<SearchParams, "city" | "radiusKm">): string[] {
  const fields: string[] = [FACET_FIELDS.categories, FACET_FIELDS.subcategories];
  if (params.city && !params.radiusKm) fields.push(FACET_FIELDS.districts);
  return fields;
}

function counts(distribution: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(distribution ?? {}).filter(([, count]) => count > 0));
}

/** `districts`: the result of the district facet query, when the main query filters a district. */
function facetsOf(result: EngineResult, fields: readonly string[], districts: EngineResult = result): SearchFacets {
  const distribution = result.facetDistribution ?? {};
  const facets: SearchFacets = { categories: counts(distribution[FACET_FIELDS.categories]), subcategories: counts(distribution[FACET_FIELDS.subcategories]) };
  if (fields.includes(FACET_FIELDS.districts)) facets.districts = counts(districts.facetDistribution?.[FACET_FIELDS.districts]);
  return facets;
}

const wordCount = (q: string): number => q.split(" ").filter(Boolean).length;

const clampHits = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(SEARCH_HITS_MAX, Math.max(1, Math.floor(value)));

function featuredQuery(params: SearchParams, now: Date): EngineQuery {
  return { q: "", filter: featuredFilter(params, now), sort: [{ field: "sortAt", dir: "desc" }], page: 1, hitsPerPage: FEATURED_POOL_SIZE };
}

function firstResult(results: EngineResult[], index = 0): EngineResult {
  const result = results[index];
  if (!result) throw new SearchUnavailableError("engine returned no result");
  return result;
}

function sumDistributions(a: EngineResult["facetDistribution"], b: EngineResult["facetDistribution"]): EngineResult["facetDistribution"] {
  if (!a && !b) return undefined;
  const sum: Record<string, Record<string, number>> = {};
  for (const distribution of [a, b]) {
    for (const [field, values] of Object.entries(distribution ?? {})) {
      const into = (sum[field] ??= {});
      for (const [value, count] of Object.entries(values)) into[value] = (into[value] ?? 0) + count;
    }
  }
  return sum;
}

/**
 * The main query and the `extra` ones in one round trip. With `fresh` (rental dates), the results
 * are the listings matching it, then the others, each group in the query's sort: the fresh page
 * and the count of the others first, then, when the page is not full, the one or two pages of the
 * others it continues with. Facets and totals add both groups up.
 */
async function mainSearch(engine: SearchEngine, main: EngineQuery, fresh: FilterExpr | undefined, extra: EngineQuery[]): Promise<{ result: EngineResult; extra: EngineResult[] }> {
  if (!fresh) {
    const results = await engine.search([main, ...extra]);
    return { result: firstResult(results), extra: results.slice(1) };
  }
  const size = main.hitsPerPage;
  const staleFilter = and([main.filter, { not: fresh }]) ?? { not: fresh };
  const results = await engine.search([{ ...main, filter: and([main.filter, fresh]) ?? fresh }, { ...main, filter: staleFilter, page: 1, hitsPerPage: 0 }, ...extra]);
  const top = firstResult(results);
  const stale = firstResult(results, 1);
  const hits = [...top.hits];
  if (size > 0 && hits.length < size && stale.totalHits > 0) {
    const from = Math.max(0, (main.page - 1) * size - top.totalHits);
    const skip = from % size;
    const need = size - hits.length;
    const firstPage = Math.floor(from / size) + 1;
    const pages = skip + need > size ? [firstPage, firstPage + 1] : [firstPage];
    const { facets: _facets, ...plain } = main;
    const more = await engine.search(pages.map((page) => ({ ...plain, filter: staleFilter, page, hitsPerPage: size })));
    hits.push(...more.flatMap((each) => each.hits).slice(skip, skip + need));
  }
  const totalHits = top.totalHits + stale.totalHits;
  const facetDistribution = sumDistributions(top.facetDistribution, stale.facetDistribution);
  return {
    result: {
      hits,
      totalHits,
      totalPages: size > 0 ? Math.ceil(Math.min(totalHits, SEARCH_MAX_TOTAL_HITS) / size) : 0,
      page: main.page,
      ...(facetDistribution ? { facetDistribution } : {}),
      processingTimeMs: top.processingTimeMs + stale.processingTimeMs,
    },
    extra: results.slice(2),
  };
}

/**
 * One search (D5-D8). Main query (`matchingStrategy: "all"`), on page 1 the À la Une pool, and with
 * a chosen district its facet query in ONE engine round trip; no hit with two words or more -> one
 * retry with "last" (approximate results). Page mode: SEARCH_PAGE_SIZE cards, SEARCH_MAX_PAGE pages
 * at most.
 */
export async function runSearch(input: SearchParams, options: RunSearchOptions = {}): Promise<SearchResponse> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const params = canonicalSearchParams(input);
  const page = params.page ?? 1;
  const hitsPerPage = clampHits(options.hitsPerPage, SEARCH_PAGE_SIZE);
  const sort = effectiveSort(params);
  const q = params.q ? normalizeQuery(params.q) : "";
  const facets = options.facets === false ? [] : facetFields(params);
  // The district choices (D7) are the other districts of the city: with a district chosen, the main
  // query (filtered on it) would only count that one, so a facet-only query drops that filter.
  const splitDistricts = params.district !== undefined && facets.includes(FACET_FIELDS.districts);
  const mainFacets = splitDistricts ? facets.filter((field) => field !== FACET_FIELDS.districts) : facets;
  const main: EngineQuery = {
    q,
    filter: and([buildFilter(params, now), options.extraFilter]),
    sort: sortSpecs(sort, params),
    page,
    hitsPerPage,
    matchingStrategy: "all",
    ...(mainFacets.length ? { facets: mainFacets } : {}),
  };
  const districtQuery: EngineQuery | undefined = splitDistricts
    ? { q, filter: and([buildFilter({ ...params, district: undefined }, now), options.extraFilter]), page: 1, hitsPerPage: 0, matchingStrategy: "all", facets: [FACET_FIELDS.districts] }
    : undefined;
  const withFeatured = options.featured !== false && page === 1;
  const engine = searchEngine();
  // Car rentals by dates: up-to-date availabilities first, then the ones to confirm (decision 4).
  const dates = activeRentalDates(params, now);
  const fresh = dates ? rentalFreshFilter(now) : undefined;
  const extra = [...(withFeatured ? [featuredQuery(params, now)] : []), ...(districtQuery ? [districtQuery] : [])];
  const first = await mainSearch(engine, main, fresh, extra);
  let result = first.result;
  let districts = districtQuery ? firstResult(first.extra, extra.indexOf(districtQuery)) : result;
  let approximate = false;
  if (options.approximate !== false && result.totalHits === 0 && wordCount(q) >= 2) {
    const retries = await mainSearch(engine, { ...main, matchingStrategy: "last" }, fresh, districtQuery ? [{ ...districtQuery, matchingStrategy: "last" as const }] : []);
    if (retries.result.totalHits > 0) {
      result = retries.result;
      districts = districtQuery ? firstResult(retries.extra) : retries.result;
      approximate = true;
    }
  }
  const pool = withFeatured ? firstResult(first.extra).hits : [];
  return {
    params,
    sort,
    hits: result.hits.map((doc) => toSearchCard(doc, now, false, dates)),
    featured: drawFeatured(pool, FEATURED_SEARCH_SLOTS, options.seed ?? randomUUID()).map((doc) => toSearchCard(doc, now, true)),
    total: result.totalHits,
    page,
    totalPages: Math.min(result.totalPages, Math.ceil(SEARCH_MAX_TOTAL_HITS / hitsPerPage), SEARCH_MAX_PAGE),
    approximate,
    facets: facetsOf(result, facets, districts),
    tookMs: Math.round(performance.now() - started),
  };
}

/** Newest listings of a scope (home "Annonces récentes", sections): page 1, no facets, no À la Une. */
export async function latestListings(params: SearchParams, limit: number): Promise<SearchCard[]> {
  const response = await runSearch({ ...params, sort: "recent", page: undefined }, { featured: false, facets: false, hitsPerPage: clampHits(limit, SEARCH_PAGE_SIZE) });
  return response.hits;
}

/** `count` À la Une cards of a scope drawn from its pool (home carousel: FEATURED_HOME_SLOTS). */
export async function featuredListings(params: SearchParams, count: number, seed?: string): Promise<SearchCard[]> {
  const now = new Date();
  const result = firstResult(await searchEngine().search([featuredQuery(canonicalSearchParams(params), now)]));
  return drawFeatured(result.hits, count, seed ?? randomUUID()).map((doc) => toSearchCard(doc, now, true));
}
