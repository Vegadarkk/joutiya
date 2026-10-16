import "server-only";
import { randomUUID } from "node:crypto";
import { cityBySlug } from "@/config/regions";
import { searchEngine } from "@/lib/search/engine";
import { normalizeQuery } from "@/lib/search/normalize";
import { toSearchCard } from "./cards";
import { FEATURED_POOL_SIZE, FEATURED_SEARCH_SLOTS, drawFeatured } from "./featured";
import { SEARCH_MAX_PAGE, SEARCH_MAX_TOTAL_HITS, SEARCH_PAGE_SIZE, canonicalSearchParams, effectiveSort, type SearchParams, type SearchSort } from "./params";
import { SearchUnavailableError, attributeField, type EngineQuery, type EngineResult, type FilterExpr, type SearchCard, type SearchFacets, type SearchResponse, type SortSpec } from "./types";

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
 * Engine filter of a search (every parameter but `q`, `sort` and `page`), or undefined when nothing
 * narrows it. Canonicalizes first, so contradictory input (district without city, criteria of
 * another subcategory) is ignored the way the URL parser ignores it. `now` is the request clock,
 * kept in the signature for time-bound filters; the main results never read `featuredUntil` (D8).
 */
export function buildFilter(input: SearchParams, _now: Date): FilterExpr | undefined {
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
  return and(parts);
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

function facetsOf(result: EngineResult, fields: readonly string[]): SearchFacets {
  const distribution = result.facetDistribution ?? {};
  const facets: SearchFacets = { categories: counts(distribution[FACET_FIELDS.categories]), subcategories: counts(distribution[FACET_FIELDS.subcategories]) };
  if (fields.includes(FACET_FIELDS.districts)) facets.districts = counts(distribution[FACET_FIELDS.districts]);
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

/**
 * One search (D5-D8). Main query (`matchingStrategy: "all"`) and, on page 1, the À la Une pool in
 * ONE engine round trip; no hit with two words or more -> one retry with "last" (approximate
 * results). Page mode: SEARCH_PAGE_SIZE cards, SEARCH_MAX_PAGE pages at most.
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
  const main: EngineQuery = {
    q,
    filter: and([buildFilter(params, now), options.extraFilter]),
    sort: sortSpecs(sort, params),
    page,
    hitsPerPage,
    matchingStrategy: "all",
    ...(facets.length ? { facets } : {}),
  };
  const withFeatured = options.featured !== false && page === 1;
  const engine = searchEngine();
  const results = await engine.search(withFeatured ? [main, featuredQuery(params, now)] : [main]);
  let result = firstResult(results);
  let approximate = false;
  if (options.approximate !== false && result.totalHits === 0 && wordCount(q) >= 2) {
    const retry = firstResult(await engine.search([{ ...main, matchingStrategy: "last" }]));
    if (retry.totalHits > 0) {
      result = retry;
      approximate = true;
    }
  }
  const pool = withFeatured ? firstResult(results, 1).hits : [];
  return {
    params,
    sort,
    hits: result.hits.map((doc) => toSearchCard(doc, now)),
    featured: drawFeatured(pool, FEATURED_SEARCH_SLOTS, options.seed ?? randomUUID()).map((doc) => toSearchCard(doc, now, true)),
    total: result.totalHits,
    page,
    totalPages: Math.min(result.totalPages, Math.ceil(SEARCH_MAX_TOTAL_HITS / hitsPerPage), SEARCH_MAX_PAGE),
    approximate,
    facets: facetsOf(result, facets),
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
