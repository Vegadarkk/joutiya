import { CONDITIONS, RENTAL_SUBCATEGORY, categoryById, criterionById, searchCriteria, subcategoryById, type Condition } from "@/config/categories";
import { cityBySlug, regionByCode } from "@/config/regions";
import { DAY_PATTERN, RENTAL_SEARCH_DAYS_MAX, dayNumber } from "@/lib/listings/rental-availability";
import { z } from "@/lib/zod";
import { SEARCH_PATH, SEARCH_Q_MAX, SEARCH_QUERY_KEYS } from "./url-keys";

// Search parameters (phase 4, design §2): the one whitelist shared by the search page, /api/search,
// the category x city pages, saved searches and their alerts. Client-safe (no server import).
// URLs use French names (`categorie`, `ville`...); the typed object uses English names. Parsing is
// lenient: an unknown or invalid value is dropped, never an error, so a hand-edited or stale URL
// still searches. `canonicalSearchParams` removes contradictions so equal searches serialize alike.

export { SEARCH_PATH, SEARCH_Q_MAX, SEARCH_QUERY_KEYS };

/** Cards per results page: 2 columns x 12 on phones, 4 x 6 on desktop. */
export const SEARCH_PAGE_SIZE = 24;
/** §6: pagination limited to 50 pages; Meilisearch `pagination.maxTotalHits` = 50 x 24. */
export const SEARCH_MAX_PAGE = 50;
export const SEARCH_MAX_TOTAL_HITS = SEARCH_PAGE_SIZE * SEARCH_MAX_PAGE;
export const SEARCH_DISTRICT_MAX = 64;
/** Radius choices around the chosen city centroid, km. */
export const RADIUS_KM = [5, 10, 20, 50, 100, 200] as const;
export type RadiusKm = (typeof RADIUS_KM)[number];
export const SEARCH_SORTS = ["recent", "relevance", "price_asc", "price_desc", "distance"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const SELLER_TYPES_FILTER = ["individual", "pro"] as const;
export type SellerTypeFilter = (typeof SELLER_TYPES_FILTER)[number];
/** Upper bound of price filters, MAD (PRICE_MAX of listings). */
export const SEARCH_PRICE_MAX = 100_000_000;
// Car rental dates (rental pack §4): bounds and duration live with the availability rules (no zod there).
export { RENTAL_SEARCH_AHEAD_DAYS, RENTAL_SEARCH_DAYS_MAX, rentalDuration } from "@/lib/listings/rental-availability";


/** Criterion filters: `f-<criterionId>=a,b` (select, multiselect), `f-<id>-min` / `-max` (number), `f-<id>=1` (boolean). */
export const CRITERION_PARAM_PREFIX = "f-";

const SORT_PARAM: Record<SearchSort, string> = {
  recent: "recentes",
  relevance: "pertinence",
  price_asc: "prix-croissant",
  price_desc: "prix-decroissant",
  distance: "distance",
};
const SELLER_PARAM: Record<SellerTypeFilter, string> = { individual: "particulier", pro: "pro" };

export type CriterionFilter =
  | { kind: "options"; values: string[] }
  | { kind: "range"; min?: number; max?: number }
  | { kind: "flag" };

export interface SearchParams {
  q?: string;
  category?: string;
  subcategory?: string;
  region?: string;
  city?: string;
  /** Only with `city`; replaces the city equality by a radius around its centroid. */
  radiusKm?: RadiusKm;
  /** Only with `city` and without `radiusKm`; normalized key (see `districtKey`). */
  district?: string;
  priceMin?: number;
  priceMax?: number;
  sellerType?: SellerTypeFilter;
  /** Seller's public id: "other listings of this seller". */
  sellerId?: string;
  /** Pro shop (the Pro's public id until phase 7 shop slugs); implies sellerType "pro". */
  shop?: string;
  donation?: true;
  withPhoto?: true;
  /** Sold-out Pro listings too (owner decision 1: out of the default results, still online). */
  includeSoldOut?: true;
  conditions?: Condition[];
  /** Only for criteria of `subcategory` (select, multiselect, number, boolean). */
  criteria?: Record<string, CriterionFilter>;
  /**
   * Car rentals only: pick-up and return days ("YYYY-MM-DD", Morocco), 1 to 60 days apart. The
   * search keeps listings free on every day from pick-up to return (rental pack §4); a start in the
   * past or beyond 180 days is ignored by the search service, not by the parser (no clock here).
   */
  dates?: RentalDates;
  /** Absent = default: relevance with a query, recent without. */
  sort?: SearchSort;
  /** 1-based; absent = 1. */
  page?: number;
}

export interface RentalDates {
  from: string;
  to: string;
}

function validDates(from: string | undefined, to: string | undefined): RentalDates | undefined {
  if (!from || !to) return undefined;
  const start = dayNumber(from);
  const end = dayNumber(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start || end - start > RENTAL_SEARCH_DAYS_MAX) return undefined;
  return { from, to };
}

const PUBLIC_ID = /^[a-hj-km-np-z2-9]{10}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Source = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: Source, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

function keysOf(source: Source): string[] {
  return source instanceof URLSearchParams ? [...new Set(source.keys())] : Object.keys(source);
}

function int(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^-?\d{1,12}$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))].slice(0, 30);
}

/**
 * First `max` UTF-16 units of `text` (what Zod's `max` counts), unpaired surrogates dropped: a cut
 * emoji would reach Meilisearch as a lone `\ud83d` escape, which its JSON parser rejects (400).
 */
export function clipText(text: string, max: number): string {
  return text.slice(0, max).replace(/\p{Cs}/gu, "");
}

/**
 * District key: what listings are filtered and faceted by. Lowercase, accents and Arabic
 * diacritics dropped, spaces collapsed; same folding as `normalizeText` (src/lib/text/normalize.ts)
 * without its server-only dependencies.
 */
export function districtKey(value: string): string {
  const key = value
    .normalize("NFKD")
    .replace(/[̀-ًͯ-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return clipText(key, SEARCH_DISTRICT_MAX);
}

/** Lenient parse of a URL query (page searchParams, URLSearchParams, saved search). */
export function parseSearchParams(source: Source): SearchParams {
  const k = SEARCH_QUERY_KEYS;
  const params: SearchParams = {};
  const q = clipText(read(source, k.q)?.replace(/\s+/g, " ").trim() ?? "", SEARCH_Q_MAX).trim();
  if (q) params.q = q;
  const category = read(source, k.category);
  if (category && ID.test(category)) params.category = category;
  const subcategory = read(source, k.subcategory);
  if (subcategory && ID.test(subcategory)) params.subcategory = subcategory;
  const region = read(source, k.region);
  if (region) params.region = region;
  const city = read(source, k.city);
  if (city && ID.test(city)) params.city = city;
  const radius = int(read(source, k.radius), 1, 1000);
  if (radius !== undefined && (RADIUS_KM as readonly number[]).includes(radius)) params.radiusKm = radius as RadiusKm;
  const district = read(source, k.district);
  if (district) params.district = districtKey(district);
  const priceMin = int(read(source, k.priceMin), 0, SEARCH_PRICE_MAX);
  if (priceMin !== undefined) params.priceMin = priceMin;
  const priceMax = int(read(source, k.priceMax), 0, SEARCH_PRICE_MAX);
  if (priceMax !== undefined) params.priceMax = priceMax;
  const seller = read(source, k.sellerType);
  const sellerType = (Object.keys(SELLER_PARAM) as SellerTypeFilter[]).find((type) => SELLER_PARAM[type] === seller);
  if (sellerType) params.sellerType = sellerType;
  const sellerId = read(source, k.sellerId);
  if (sellerId && PUBLIC_ID.test(sellerId)) params.sellerId = sellerId;
  const shop = read(source, k.shop);
  if (shop && PUBLIC_ID.test(shop)) params.shop = shop;
  if (read(source, k.donation) === "1") params.donation = true;
  if (read(source, k.withPhoto) === "1") params.withPhoto = true;
  if (read(source, k.includeSoldOut) === "1") params.includeSoldOut = true;
  const conditions = list(read(source, k.conditions)).filter((value): value is Condition => (CONDITIONS as readonly string[]).includes(value));
  if (conditions.length) params.conditions = conditions;
  const dates = validDates(read(source, k.rentFrom), read(source, k.rentTo));
  if (dates) params.dates = dates;
  const sortParam = read(source, k.sort);
  const sort = SEARCH_SORTS.find((value) => SORT_PARAM[value] === sortParam);
  if (sort) params.sort = sort;
  const page = int(read(source, k.page), 1, SEARCH_MAX_PAGE);
  if (page !== undefined && page > 1) params.page = page;

  const criteria: Record<string, CriterionFilter> = {};
  for (const key of keysOf(source)) {
    if (!key.startsWith(CRITERION_PARAM_PREFIX)) continue;
    const rest = key.slice(CRITERION_PARAM_PREFIX.length);
    const range = /^(.+)-(min|max)$/.exec(rest);
    const id = range && criterionById(range[1] ?? "")?.type === "number" ? (range[1] ?? "") : rest;
    const criterion = criterionById(id);
    if (!criterion) continue;
    const raw = read(source, key);
    if (criterion.type === "number" && range) {
      const value = int(raw, criterion.min ?? -1_000_000_000, criterion.max ?? 1_000_000_000);
      if (value === undefined) continue;
      const current = criteria[id];
      const next = current?.kind === "range" ? { ...current } : { kind: "range" as const };
      next[range[2] as "min" | "max"] = value;
      criteria[id] = next;
    } else if (criterion.type === "select" || criterion.type === "multiselect") {
      const values = list(raw).filter((value) => criterion.options?.includes(value));
      if (values.length) criteria[id] = { kind: "options", values };
    } else if (criterion.type === "boolean" && raw === "1") {
      criteria[id] = { kind: "flag" };
    }
  }
  if (Object.keys(criteria).length) params.criteria = criteria;
  return canonicalSearchParams(params);
}

/**
 * Removes contradictions and values outside the whitelist: subcategory implies its category,
 * city implies its region, radius and district need a city (radius wins), criteria need the
 * subcategory that declares them (or the category's shared filters), distance sort needs a city, price bounds are ordered and
 * dropped by "donations only".
 */
export function canonicalSearchParams(input: SearchParams): SearchParams {
  const params: SearchParams = { ...input };
  const sub = params.subcategory ? subcategoryById(params.subcategory) : undefined;
  if (params.subcategory && !sub) delete params.subcategory;
  if (sub) {
    if (params.category && params.category !== sub.categoryId) delete params.subcategory;
    else params.category = sub.categoryId;
  }
  if (params.category && !categoryById(params.category)) delete params.category;
  const city = params.city ? cityBySlug(params.city) : undefined;
  if (params.city && !city) delete params.city;
  if (city) params.region = city.regionCode;
  if (params.region && !regionByCode(params.region)) delete params.region;
  if (!params.city) {
    delete params.radiusKm;
    delete params.district;
  }
  if (params.radiusKm) delete params.district;
  if (params.district !== undefined && !params.district) delete params.district;
  // Donations have no price (document.ts), so a price bound would leave none: the donation filter
  // wins. A price sort stays (harmless: all equal) so the sort menu never snaps back.
  if (params.donation) {
    delete params.priceMin;
    delete params.priceMax;
  }
  if (params.priceMin !== undefined && params.priceMax !== undefined && params.priceMin > params.priceMax) {
    [params.priceMin, params.priceMax] = [params.priceMax, params.priceMin];
  }
  if (params.shop) params.sellerType = "pro";
  if (params.conditions) {
    const conditions = CONDITIONS.filter((value) => params.conditions?.includes(value));
    if (conditions.length) params.conditions = conditions;
    else delete params.conditions;
  }
  if (params.criteria) {
    const allowed = new Set(searchCriteria(params.category, params.subcategory).map((criterion) => criterion.id));
    const criteria: Record<string, CriterionFilter> = {};
    for (const id of Object.keys(params.criteria).sort()) {
      const filter = params.criteria[id];
      const criterion = criterionById(id);
      if (!filter || !criterion || !allowed.has(id)) continue;
      if (filter.kind === "range" && criterion.type === "number" && (filter.min !== undefined || filter.max !== undefined)) {
        const range: CriterionFilter = { kind: "range" };
        if (filter.min !== undefined) range.min = filter.min;
        if (filter.max !== undefined) range.max = filter.max;
        if (range.min !== undefined && range.max !== undefined && range.min > range.max) [range.min, range.max] = [range.max, range.min];
        criteria[id] = range;
      } else if (filter.kind === "options" && (criterion.type === "select" || criterion.type === "multiselect")) {
        const values = (criterion.options ?? []).filter((option) => filter.values.includes(option));
        if (values.length) criteria[id] = { kind: "options", values };
      } else if (filter.kind === "flag" && criterion.type === "boolean") {
        criteria[id] = { kind: "flag" };
      }
    }
    if (Object.keys(criteria).length) params.criteria = criteria;
    else delete params.criteria;
  }
  if (params.dates) {
    const dates = params.subcategory === RENTAL_SUBCATEGORY ? validDates(params.dates.from, params.dates.to) : undefined;
    if (dates) params.dates = dates;
    else delete params.dates;
  }
  if (params.sort === "distance" && !params.city) delete params.sort;
  if (params.sort && params.sort === defaultSort(params)) delete params.sort;
  if (params.page !== undefined && (params.page <= 1 || params.page > SEARCH_MAX_PAGE)) delete params.page;
  return params;
}

/** Relevance when the visitor typed words, newest first otherwise (Leboncoin's default); car rentals by dates: cheapest day first. */
export function defaultSort(params: Pick<SearchParams, "q" | "dates">): SearchSort {
  if (params.dates) return "price_asc";
  return params.q ? "relevance" : "recent";
}

export function effectiveSort(params: SearchParams): SearchSort {
  return params.sort ?? defaultSort(params);
}

/** Canonical URL query (fixed key order, defaults omitted). */
export function searchParamsToQuery(input: SearchParams): URLSearchParams {
  const params = canonicalSearchParams(input);
  const k = SEARCH_QUERY_KEYS;
  const query = new URLSearchParams();
  if (params.q) query.set(k.q, params.q);
  if (params.category) query.set(k.category, params.category);
  if (params.subcategory) query.set(k.subcategory, params.subcategory);
  if (params.region && !params.city) query.set(k.region, params.region);
  if (params.city) query.set(k.city, params.city);
  if (params.radiusKm) query.set(k.radius, String(params.radiusKm));
  if (params.district) query.set(k.district, params.district);
  if (params.priceMin !== undefined) query.set(k.priceMin, String(params.priceMin));
  if (params.priceMax !== undefined) query.set(k.priceMax, String(params.priceMax));
  if (params.sellerType && !params.shop) query.set(k.sellerType, SELLER_PARAM[params.sellerType]);
  if (params.sellerId) query.set(k.sellerId, params.sellerId);
  if (params.shop) query.set(k.shop, params.shop);
  if (params.donation) query.set(k.donation, "1");
  if (params.withPhoto) query.set(k.withPhoto, "1");
  if (params.includeSoldOut) query.set(k.includeSoldOut, "1");
  if (params.conditions?.length) query.set(k.conditions, params.conditions.join(","));
  for (const [id, filter] of Object.entries(params.criteria ?? {})) {
    if (filter.kind === "options") query.set(`${CRITERION_PARAM_PREFIX}${id}`, filter.values.join(","));
    else if (filter.kind === "flag") query.set(`${CRITERION_PARAM_PREFIX}${id}`, "1");
    else {
      if (filter.min !== undefined) query.set(`${CRITERION_PARAM_PREFIX}${id}-min`, String(filter.min));
      if (filter.max !== undefined) query.set(`${CRITERION_PARAM_PREFIX}${id}-max`, String(filter.max));
    }
  }
  if (params.dates) {
    query.set(k.rentFrom, params.dates.from);
    query.set(k.rentTo, params.dates.to);
  }
  if (params.sort) query.set(k.sort, SORT_PARAM[params.sort]);
  if (params.page) query.set(k.page, String(params.page));
  return query;
}

/** Query object for next-intl `Link`/`router.push({ pathname: SEARCH_PATH, query })`. */
export function searchQueryObject(params: SearchParams): Record<string, string> {
  return Object.fromEntries(searchParamsToQuery(params));
}

/** `/recherche?...` without the locale prefix. */
export function searchPath(params: SearchParams): string {
  const query = searchParamsToQuery(params).toString();
  return query ? `${SEARCH_PATH}?${query}` : SEARCH_PATH;
}

/** True when nothing narrows the search (no words, no filter). Page, sort and the sold-out switch do not count. */
export function isBlankSearch(params: SearchParams): boolean {
  const { sort: _sort, page: _page, includeSoldOut: _soldOut, ...rest } = canonicalSearchParams(params);
  return Object.keys(rest).length === 0;
}

/** Same search ignoring page (saved-search de-duplication, "already saved" state). */
export function sameSearch(a: SearchParams, b: SearchParams): boolean {
  const strip = (params: SearchParams) => {
    const query = searchParamsToQuery({ ...params, page: undefined });
    return query.toString();
  };
  return strip(a) === strip(b);
}

/** Stored form of a search (saved searches): the canonical object, validated strictly. */
export const storedSearchParamsSchema = z
  .object({
    q: z.string().min(1).max(SEARCH_Q_MAX).optional(),
    category: z.string().regex(ID).max(40).optional(),
    subcategory: z.string().regex(ID).max(40).optional(),
    region: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
    city: z.string().regex(ID).max(64).optional(),
    radiusKm: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(50), z.literal(100), z.literal(200)]).optional(),
    district: z.string().min(1).max(SEARCH_DISTRICT_MAX).optional(),
    priceMin: z.number().int().min(0).max(SEARCH_PRICE_MAX).optional(),
    priceMax: z.number().int().min(0).max(SEARCH_PRICE_MAX).optional(),
    sellerType: z.enum(SELLER_TYPES_FILTER).optional(),
    sellerId: z.string().regex(PUBLIC_ID).optional(),
    shop: z.string().regex(PUBLIC_ID).optional(),
    donation: z.literal(true).optional(),
    withPhoto: z.literal(true).optional(),
    includeSoldOut: z.literal(true).optional(),
    conditions: z.array(z.enum(CONDITIONS)).min(1).max(CONDITIONS.length).optional(),
    criteria: z
      .record(
        z.string().regex(ID).max(40),
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("options"), values: z.array(z.string().max(80)).min(1).max(60) }).strict(),
          z.object({ kind: z.literal("range"), min: z.number().int().optional(), max: z.number().int().optional() }).strict(),
          z.object({ kind: z.literal("flag") }).strict(),
        ]),
      )
      .optional(),
    dates: z.object({ from: z.string().regex(DAY_PATTERN), to: z.string().regex(DAY_PATTERN) }).strict().optional(),
    sort: z.enum(SEARCH_SORTS).optional(),
  })
  .strict();
export type StoredSearchParams = z.infer<typeof storedSearchParamsSchema>;
