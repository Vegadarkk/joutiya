import "server-only";
import { logger } from "@/lib/logging/logger";
import { searchEngine } from "@/lib/search/engine";
import { attributeField, type EngineQuery, type FilterExpr, type SearchEngine } from "@/lib/search/types";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import {
  PRICE_GUIDE_MAX_PRICES,
  PRICE_GUIDE_SCOPES,
  PRICE_GUIDE_TTL_SECONDS,
  comparableSpec,
  comparableStats,
  specKey,
  type ComparableSpec,
  type GuideListing,
  type PriceGuide,
  type PriceGuideScope,
} from "./rules";

// « Prix repère » engine side (Carte vivante lot 5): the comparables come from the search index
// (published, visible listings only, src/lib/search/document.ts), never from Firestore. One
// multi-search round trip asks the city, the region and Morocco at once (at most
// PRICE_GUIDE_MAX_PRICES prices each, the most recent first); the first area with enough
// comparables wins, each seller counting twice at most (rules.ts). Example listings are dropped from
// the hits (so the guide never depends on the index settings), the listing itself, donations and
// sold-out Pro listings by the filter. The result, or its absence, is kept 24 h in
// valkey-ratelimit (allkeys-lru: a cache may be evicted, never the queue's jobs), keyed by listing,
// with the comparables' description so an edited listing gets a fresh guide.

export interface GuideSubject extends GuideListing {
  id: string;
  citySlug: string;
  regionCode: string;
}

/** Fields read per hit: the price, its seller (per-seller cap), and the example mark. */
const HIT_FIELDS = ["id", "price", "isExample", "sellerPublicId"] as const;

function criteriaFilters(spec: ComparableSpec): FilterExpr[] {
  return [
    ...Object.entries(spec.equals).map(([id, value]): FilterExpr => ({ field: attributeField(id), op: "eq", value })),
    ...Object.entries(spec.ranges).flatMap(([id, range]): FilterExpr[] => [
      { field: attributeField(id), op: "gte", value: range.min },
      { field: attributeField(id), op: "lte", value: range.max },
    ]),
  ];
}

function areaFilter(scope: PriceGuideScope, subject: GuideSubject): FilterExpr[] {
  if (scope === "city") return [{ field: "citySlug", op: "eq", value: subject.citySlug }];
  if (scope === "region") return [{ field: "regionCode", op: "eq", value: subject.regionCode }];
  return [];
}

/** The engine query of one area (exported for the tests). */
export function comparablesQuery(spec: ComparableSpec, subject: GuideSubject, scope: PriceGuideScope): EngineQuery {
  return {
    q: spec.text,
    filter: {
      and: [
        { field: "subcategoryId", op: "eq", value: spec.subcategoryId },
        ...areaFilter(scope, subject),
        { field: "price", op: "gt", value: 0 },
        { field: "isDonation", op: "eq", value: false },
        { not: { field: "soldOut", op: "eq", value: true } },
        { not: { field: "id", op: "eq", value: subject.id } },
        ...criteriaFilters(spec),
      ],
    },
    sort: [{ field: "sortAt", dir: "desc" }],
    page: 1,
    hitsPerPage: PRICE_GUIDE_MAX_PRICES,
    fields: HIT_FIELDS,
  };
}

/** The place an area is named after. */
const placeOf = (scope: PriceGuideScope, subject: GuideSubject) => (scope === "city" ? subject.citySlug : scope === "region" ? subject.regionCode : "ma");

/** Computes the guide (no cache). Null: no guide for this listing, or too few comparables everywhere. */
export async function computePriceGuide(subject: GuideSubject, engine: SearchEngine = searchEngine()): Promise<PriceGuide | null> {
  const spec = comparableSpec(subject);
  if (!spec) return null;
  // Region and Morocco are the same area when the city is unknown to the index: still asked, cheap.
  const results = await engine.search(PRICE_GUIDE_SCOPES.map((scope) => comparablesQuery(spec, subject, scope)));
  for (const [index, scope] of PRICE_GUIDE_SCOPES.entries()) {
    const hits = (results[index]?.hits ?? []) as { id?: string; price?: number; isExample?: boolean; sellerPublicId?: string }[];
    const comparables = hits
      .filter((hit) => hit.isExample !== true && hit.id !== subject.id)
      .flatMap((hit) => (typeof hit.price === "number" && typeof hit.sellerPublicId === "string" ? [{ price: hit.price, seller: hit.sellerPublicId }] : []));
    const stats = comparableStats(comparables);
    if (stats) return { ...stats, scope, place: placeOf(scope, subject) };
  }
  return null;
}

// ---- Cache --------------------------------------------------------------------------------------

export interface GuideCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** What one cache entry holds: the comparables' description and the guide (or null). */
interface CachedGuide {
  key: string;
  guide: PriceGuide | null;
}

let override: GuideCache | null | undefined;

/** Tests only: a cache in place of Valkey (null: none; undefined: the configured one). */
export function setPriceGuideCacheForTests(cache: GuideCache | null | undefined): void {
  override = cache;
}

/** A cache call never holds a page render for long. */
const CACHE_TIMEOUT_MS = 300;

function timed<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("price guide cache timeout")), CACHE_TIMEOUT_MS))]);
}

function guideCache(): GuideCache | null {
  if (override !== undefined) return override;
  if (!isValkeyConfigured("ratelimit")) return null;
  const client = valkey("ratelimit");
  // The client is lazy and refuses commands before it is ready (no offline queue): connect first.
  const ready = async () => {
    if (client.status === "wait") await client.connect().catch(() => undefined);
  };
  return {
    get: (key) => timed(ready().then(() => client.get(key))),
    set: async (key, value, ttl) => {
      await timed(ready().then(() => client.set(key, value, "EX", ttl)));
    },
  };
}

/** v2: the per-seller cap (guides cached by v1 without it are left to expire). */
export const priceGuideCacheKey = (listingId: string) => `pg:v2:${listingId}`;

/** The entry of `listingId`, or null (none, unreadable, Valkey down). */
async function cachedGuide(listingId: string): Promise<CachedGuide | null> {
  const cache = guideCache();
  if (!cache) return null;
  try {
    const raw = await cache.get(priceGuideCacheKey(listingId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedGuide>;
    return typeof value.key === "string" && value.guide !== undefined ? { key: value.key, guide: value.guide ?? null } : null;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "price guide: cache unavailable");
    return null;
  }
}

async function storeGuide(listingId: string, entry: CachedGuide): Promise<void> {
  const cache = guideCache();
  if (!cache) return;
  try {
    await cache.set(priceGuideCacheKey(listingId), JSON.stringify(entry), PRICE_GUIDE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "price guide: not cached");
  }
}

/** Key of a listing that gets no guide at all (donation, no price, excluded subcategory, example). */
const NO_GUIDE = "-";

/** Cache key of a subject: its comparables and its area (a listing moved to another city changes it). */
export function subjectKey(subject: GuideSubject): string {
  const spec = comparableSpec(subject);
  return spec ? `${specKey(spec)}|${subject.citySlug}|${subject.regionCode}` : NO_GUIDE;
}

/**
 * The guide of a listing, from the cache when it still describes the same comparables, else
 * computed and cached (an absent guide too). Never throws: the engine down or misconfigured means
 * no guide, not cached (logged).
 */
export async function priceGuideFor(subject: GuideSubject, engine?: SearchEngine): Promise<PriceGuide | null> {
  const key = subjectKey(subject);
  const cached = await cachedGuide(subject.id);
  if (cached && cached.key === key) return cached.guide;
  let guide: PriceGuide | null = null;
  if (key !== NO_GUIDE) {
    try {
      guide = await computePriceGuide(subject, engine ?? searchEngine());
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "price guide: engine unavailable");
      return null;
    }
  }
  await storeGuide(subject.id, { key, guide });
  return guide;
}
