import "server-only";
import { categoryById, subcategoryById } from "@/config/categories";
import { CITIES, cityBySlug, type City } from "@/config/regions";
import { searchEngine } from "@/lib/search/engine";
import { buildFilter, NOT_EXAMPLE } from "@/lib/search/service";
import type { SearchParams } from "./params";
import { SearchUnavailableError, type EngineQuery } from "./types";

// Category landing pages (design D15): /c/{category}, /c/{category}/{subcategory|city},
// /c/{category}/{subcategory}/{city}. Segments are resolved from config only, before any engine
// call (ISR caches whatever a path renders, 404s included). Counts come from engine facets.

/** Below this many listings a page is `noindex, follow` and stays out of the sitemaps. */
export const SEO_MIN_LISTINGS = 3;
/** Cards on a landing page (page 1 only; deeper browsing is /recherche). */
export const SEO_PAGE_SIZE = 24;
export const SEO_CITY_LINKS = 12;

export interface SeoTarget {
  category: string;
  subcategory?: string;
  city?: string;
}

/**
 * Path segments after /c/ -> target, or null (404). The second segment is a subcategory of that
 * category first, else a city (no subcategory id equals a city slug: unit test); the third only
 * follows a subcategory and must be a city.
 */
export function resolveSeoSegments(category: string, rest: readonly string[]): SeoTarget | null {
  if (!categoryById(category) || rest.length > 2) return null;
  const [second, third] = rest;
  if (second === undefined) return { category };
  const sub = subcategoryById(second);
  if (sub && sub.categoryId === category) {
    if (third === undefined) return { category, subcategory: sub.id };
    return cityBySlug(third) ? { category, subcategory: sub.id, city: third } : null;
  }
  if (third === undefined && cityBySlug(second)) return { category, city: second };
  return null;
}

/** Path without the locale: "/c/vehicules/voitures/casablanca". */
export function seoPath(target: SeoTarget): string {
  return ["/c", target.category, target.subcategory, target.city].filter(Boolean).join("/");
}

/** The same scope as search parameters ("Voir les N annonces", engine filters). */
export function seoSearchParams(target: SeoTarget): SearchParams {
  return { category: target.category, ...(target.subcategory ? { subcategory: target.subcategory } : {}), ...(target.city ? { city: target.city } : {}) };
}

export type SeoVerdict = "index" | "noindex" | "notFound";

/**
 * D15: /c/{category} always answers 200 (the home links it), noindex below SEO_MIN_LISTINGS.
 * Deeper pages: 0 listings = 404 (Google: 404 for empty facets), 1-2 = noindex, follow.
 * `indexable`: the real listings among `total` (example listings never make a page indexable).
 */
export function seoVerdict(target: SeoTarget, total: number, indexable = total): SeoVerdict {
  if (indexable >= SEO_MIN_LISTINGS) return "index";
  const deeper = Boolean(target.subcategory || target.city);
  return deeper && total === 0 ? "notFound" : "noindex";
}

/** Great-circle distance in km (city centroids). */
export function distanceKm(a: Pick<City, "lat" | "lng">, b: Pick<City, "lat" | "lng">): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface CityLink {
  city: City;
  count: number;
}

/**
 * City links of a page: the cities with listings in its scope. Around a city: the nearest other
 * cities; otherwise the busiest cities (then by population).
 */
export function cityLinks(counts: Record<string, number>, around?: string, limit = SEO_CITY_LINKS): CityLink[] {
  const origin = around ? cityBySlug(around) : undefined;
  const links = CITIES.filter((city) => (counts[city.slug] ?? 0) > 0 && city.slug !== around).map((city) => ({ city, count: counts[city.slug] ?? 0 }));
  if (origin) links.sort((a, b) => distanceKm(origin, a.city) - distanceKm(origin, b.city));
  else links.sort((a, b) => b.count - a.count || b.city.population - a.city.population);
  return links.slice(0, limit);
}

export interface SeoCounts {
  /** Subcategory -> listings in the scope without its subcategory (category [+ city]). */
  subcategories: Record<string, number>;
  /** City -> listings in the scope without its city (category [+ subcategory]). */
  cities: Record<string, number>;
  /** Exact listings of the page's own scope (facet sums are not capped by maxTotalHits). */
  total: number;
  /** Listings of the page's own scope without the example listings: the D15 index threshold. */
  indexable: number;
}

function positive(distribution: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(distribution ?? {}).filter(([, count]) => count > 0));
}

function facetQuery(params: SearchParams, field: string, now: Date): EngineQuery {
  return { q: "", filter: buildFilter(params, now), page: 1, hitsPerPage: 1, facets: [field], fields: ["id"] };
}

/** Real listings of the page's own scope (exhaustive totalHits). */
function realQuery(params: SearchParams, now: Date): EngineQuery {
  const scope = buildFilter(params, now);
  return { q: "", filter: scope ? { and: [scope, NOT_EXAMPLE] } : NOT_EXAMPLE, page: 1, hitsPerPage: 1, fields: ["id"] };
}

/** Chips, city links and the index threshold of a landing page: three queries in one engine round trip. */
export async function seoCounts(target: SeoTarget, now = new Date()): Promise<SeoCounts> {
  const { subcategory: _subcategory, ...withoutSubcategory } = target;
  const { city: _city, ...withoutCity } = target;
  const [subs, cities, real] = await searchEngine().search([
    facetQuery(seoSearchParams(withoutSubcategory), "subcategoryId", now),
    facetQuery(seoSearchParams(withoutCity), "citySlug", now),
    realQuery(seoSearchParams(target), now),
  ]);
  if (!subs || !cities || !real) throw new SearchUnavailableError("engine returned no result");
  const subcategories = positive(subs.facetDistribution?.subcategoryId);
  const cityCounts = positive(cities.facetDistribution?.citySlug);
  const total = target.subcategory
    ? (subcategories[target.subcategory] ?? 0)
    : Object.values(subcategories).reduce((sum, count) => sum + count, 0);
  return { subcategories, cities: cityCounts, total, indexable: real.totalHits };
}
