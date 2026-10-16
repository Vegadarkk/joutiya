import type { Condition } from "@/config/categories";
import type { SearchParams, SearchSort } from "./params";

// Search contracts (phase 4, design §3). Client-safe types: the engine adapters
// (meili.ts, memory.ts), the indexer, the search service, the API and the UI all build on them.

/** Live index (§5 `listings_v1`); a full rebuild fills SEARCH_REBUILD_INDEX then swaps both. */
export const SEARCH_INDEX = "listings_v1";
export const SEARCH_REBUILD_INDEX = "listings_v2";

export interface SearchPhoto {
  id: string;
  w: number;
  h: number;
  blurhash: string;
}

/**
 * One indexed listing (§5 "Ce qui vit dans Meilisearch"). Only `published` listings, not hidden,
 * moderation `auto_ok` or `human_ok`. Never the owner uid, proId, phone or exact position.
 * Dates are epoch milliseconds (filterable, sortable numbers).
 */
export interface SearchDocument {
  id: string;
  slugId: string;
  title: string;
  /** Truncated (SEARCH_DESCRIPTION_MAX). */
  description: string;
  /** Category and subcategory names, French and Arabic ("Voitures سيارات"). */
  categoryText: string;
  /** City names (fr, ar), region names (fr, ar) and the district label. */
  placeText: string;
  /** Text and option criteria values with their labels (brand, model, fuel...). */
  attrsText: string;
  categoryId: string;
  subcategoryId: string;
  regionCode: string;
  citySlug: string;
  /** `districtKey(location.district)`; absent without district. */
  district?: string;
  sellerType: "individual" | "pro";
  sellerPublicId: string;
  /** Integer MAD; absent when null ("à discuter", donation). */
  price?: number;
  priceNegotiable: boolean;
  isDonation: boolean;
  condition?: Condition;
  hasPhoto: boolean;
  photo?: SearchPhoto;
  photoCount: number;
  sortAt: number;
  /** Listing `updatedAt` (sitemap lastmod). */
  updatedAt: number;
  /** `sitemapShardOf(id)`: the sitemap file listing this document. */
  sitemapShard: number;
  /** §8 "Remontée": the position comes from a paid bump (`sortSource === "bump"`). */
  isBumped: boolean;
  /** Epoch ms; À la Une while > now (separate query, never the main sort). */
  featuredUntil?: number;
  /** Rounded city (later district) centroid. */
  _geo: { lat: number; lng: number };
  version: number;
  /** Flattened criteria: `a_<criterion id with "_" for "-">` (see `attributeField`). */
  [attribute: `a_${string}`]: string | string[] | number | boolean | undefined;
}

/** Meilisearch field of a criterion: `car-brand` -> `a_car_brand`. */
export function attributeField(criterionId: string): `a_${string}` {
  return `a_${criterionId.replaceAll("-", "_")}`;
}

export const SEARCH_DESCRIPTION_MAX = 1500;

/** Listing sitemap files (`/sitemaps/listings-{k}.xml`); 50 000 URLs each at most. */
export const SITEMAP_SHARDS = 16;

/** FNV-1a 32-bit of the listing id, modulo SITEMAP_SHARDS: stable across reindexes. */
export function sitemapShardOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SITEMAP_SHARDS;
}

/** Fields a results card needs (attributesToRetrieve of every listing query). */
export const CARD_FIELDS = [
  "id",
  "slugId",
  "title",
  "subcategoryId",
  "price",
  "priceNegotiable",
  "isDonation",
  "citySlug",
  "photo",
  "photoCount",
  "sellerType",
  "sortAt",
  "isBumped",
  "featuredUntil",
] as const satisfies readonly (keyof SearchDocument)[];
export type CardDocument = Pick<SearchDocument, (typeof CARD_FIELDS)[number]>;

// ---- Engine query model (adapters translate it; never built from raw user strings).

export type FilterValue = string | number | boolean;
export type FilterExpr =
  | { and: FilterExpr[] }
  | { or: FilterExpr[] }
  | { not: FilterExpr }
  | { field: string; op: "eq"; value: FilterValue }
  | { field: string; op: "in"; values: FilterValue[] }
  | { field: string; op: "gt" | "gte" | "lt" | "lte"; value: number }
  | { field: string; op: "exists" }
  | { geoRadius: { lat: number; lng: number; meters: number } };

export type SortSpec = { field: "sortAt" | "price"; dir: "asc" | "desc" } | { geoPoint: { lat: number; lng: number }; dir: "asc" };

export interface EngineQuery {
  /** Normalized text (src/lib/search/normalize.ts); "" = browse. */
  q: string;
  filter?: FilterExpr;
  /** Empty = relevance (ranking rules). */
  sort?: SortSpec[];
  /** 1-based. */
  page: number;
  hitsPerPage: number;
  facets?: string[];
  /** "all" by default (every word must match); "last" for the approximate fallback. */
  matchingStrategy?: "all" | "last";
  /** Default CARD_FIELDS. */
  fields?: readonly string[];
}

export interface EngineResult<T = CardDocument> {
  hits: T[];
  /** Exhaustive up to SEARCH_MAX_TOTAL_HITS (Meilisearch page mode). */
  totalHits: number;
  totalPages: number;
  page: number;
  facetDistribution?: Record<string, Record<string, number>>;
  processingTimeMs: number;
}

export interface SearchEngine {
  readonly kind: "meili" | "memory";
  /** Several queries in one round trip (main results + À la Une). */
  search(queries: EngineQuery[]): Promise<EngineResult[]>;
  /** Add or replace, resolves once the engine applied it (task succeeded). */
  upsert(documents: SearchDocument[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /** Stored versions for reconciliation, all documents, in pages. */
  versions(): AsyncIterable<{ id: string; version: number }[]>;
  /**
   * Documents matching `filter`, `fields` only, in pages of `pageSize` (documents API: not capped by
   * maxTotalHits; unordered). Sitemaps (search key needs `documents.get`).
   */
  documents<T extends Partial<SearchDocument>>(options: { filter?: FilterExpr; fields: readonly (keyof SearchDocument)[]; pageSize?: number; max?: number }): AsyncIterable<T[]>;
  /** Creates the index and applies the settings when they differ (worker start, scripts). */
  ensureReady(): Promise<{ created: boolean; settingsUpdated: boolean }>;
  /** Reachable and the index exists. */
  healthy(): Promise<boolean>;
}

/** Engine missing or unreachable: the API answers 503 `search_unavailable`, pages show an error state. */
export class SearchUnavailableError extends Error {
  constructor(message = "search unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchUnavailableError";
  }
}

// ---- Service results (search page, /api/search, /c pages, home, alerts).

export interface SearchCard {
  id: string;
  slugId: string;
  title: string;
  subcategoryId: string | null;
  price: number | null;
  priceNegotiable: boolean;
  isDonation: boolean;
  citySlug: string | null;
  photo: SearchPhoto | null;
  photoCount: number;
  sellerType: "individual" | "pro";
  /** ISO 8601. */
  sortAt: string;
  /** "Remontée" mention (§8). */
  bumped: boolean;
  /** Served in an À la Une slot: "À la Une · Sponsorisé" mention (§8). */
  featured: boolean;
}

export interface SearchFacets {
  categories: Record<string, number>;
  subcategories: Record<string, number>;
  /** With a city only: district key -> count. */
  districts?: Record<string, number>;
}

export interface SearchResponse {
  /** Canonical parameters actually applied. */
  params: SearchParams;
  sort: SearchSort;
  hits: SearchCard[];
  /** Page 1 only: up to 2 À la Une cards drawn at random (§8), shown above the results. */
  featured: SearchCard[];
  total: number;
  page: number;
  totalPages: number;
  /** No result with every word: results match some of the words ("résultats approchants"). */
  approximate: boolean;
  facets: SearchFacets;
  tookMs: number;
}
