import "server-only";
import { CATEGORIES } from "@/config/categories";
import { GUIDE_RUBRICS } from "@/content/guide/catalog";
import { CANONICAL_ORIGIN, HREFLANG_LOCALES } from "@/config/site";
import { serverEnv, type ServerEnv } from "@/lib/env";
import { alternates } from "@/lib/i18n/metadata";
import { searchEngine } from "@/lib/search/engine";
import { buildFilter, NOT_EXAMPLE } from "@/lib/search/service";
import { SEO_MIN_LISTINGS, seoPath, seoSearchParams, type SeoTarget } from "./seo";
import { SITEMAP_SHARDS, SearchUnavailableError, type EngineQuery, type SearchDocument } from "./types";

// XML sitemaps (design D16), production only, served by src/app/sitemaps/[file]/route.ts (ISR, one
// hour) and reached by verified bots only (Cloudflare WAF rule `sitemaps_verified_bots`):
// - index.xml (also /sitemap.xml by rewrite): pages.xml + one listings-{k}.xml per non-empty shard;
// - pages.xml: home, the admin procedures guide and the indexable landing pages (>= SEO_MIN_LISTINGS
//   listings, facet counts);
// - listings-{k}.xml: listings with `sitemapShard === k` (documents API, not capped by maxTotalHits),
//   lastmod = listing updatedAt.
// Every URL comes in fr and ar, each <url> carrying the whole hreflang cluster (+ x-default), from
// the same helper as the pages' <head> (alternates()); Tarifit stays out of the cluster.

/** Google: 50 000 URLs per sitemap file. */
export const SITEMAP_URL_MAX = 50_000;
/** Listings per shard file: each listing is one URL per hreflang locale. */
export const SITEMAP_LISTINGS_MAX = Math.floor(SITEMAP_URL_MAX / HREFLANG_LOCALES.length);
const DOCUMENTS_PAGE = 1_000;

export type SitemapFile = { kind: "index" } | { kind: "pages" } | { kind: "listings"; shard: number };

/** "index.xml" | "pages.xml" | "listings-{0..SITEMAP_SHARDS-1}.xml", else null. */
export function parseSitemapFile(file: string): SitemapFile | null {
  if (file === "index.xml") return { kind: "index" };
  if (file === "pages.xml") return { kind: "pages" };
  const match = /^listings-(0|[1-9]\d?)\.xml$/.exec(file);
  const shard = match ? Number(match[1]) : NaN;
  return Number.isInteger(shard) && shard < SITEMAP_SHARDS ? { kind: "listings", shard } : null;
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const absolute = (path: string) => `${CANONICAL_ORIGIN}${path}`;

/** One <url> per hreflang locale of `path` (locale-free), each with the full cluster. */
export function urlEntries(path: string, lastmod?: number): string[] {
  const languages = Object.entries(alternates("fr", path)?.languages ?? {}).map(([tag, href]) => [tag, absolute(String(href))] as const);
  const links = languages.map(([tag, href]) => `<xhtml:link rel="alternate" hreflang="${escapeXml(tag)}" href="${escapeXml(href)}"/>`).join("");
  const modified = lastmod !== undefined && Number.isFinite(lastmod) ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "";
  return HREFLANG_LOCALES.map((locale) => `<url><loc>${escapeXml(absolute(`/${locale}${path}`))}</loc>${modified}${links}</url>`);
}

export function urlset(entries: readonly string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    entries.map((entry) => `${entry}\n`).join("") +
    `</urlset>\n`
  );
}

export function sitemapIndex(files: readonly string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    files.map((file) => `<sitemap><loc>${escapeXml(absolute(`/sitemaps/${file}`))}</loc></sitemap>\n`).join("") +
    `</sitemapindex>\n`
  );
}

/** Real listings only: example listings never make a landing page indexable (same rule as seoCounts). */
function countQuery(target: SeoTarget, facet: string): EngineQuery {
  const scope = buildFilter(seoSearchParams(target), new Date());
  return { q: "", filter: scope ? { and: [scope, NOT_EXAMPLE] } : NOT_EXAMPLE, page: 1, hitsPerPage: 1, facets: [facet], fields: ["id"] };
}

/** Shards holding at least one document. */
export async function listingShards(): Promise<number[]> {
  const [result] = await searchEngine().search([{ q: "", page: 1, hitsPerPage: 1, facets: ["sitemapShard"], fields: ["id"] }]);
  if (!result) throw new SearchUnavailableError("engine returned no result");
  return Object.entries(result.facetDistribution?.sitemapShard ?? {})
    .filter(([, count]) => count > 0)
    .map(([shard]) => Number(shard))
    .filter((shard) => Number.isInteger(shard) && shard >= 0 && shard < SITEMAP_SHARDS)
    .sort((a, b) => a - b);
}

/**
 * Landing pages worth indexing (D15 thresholds): every subcategory x city count from one facet
 * query per subcategory (one engine round trip); category and city totals are their sums, since a
 * listing has exactly one subcategory and one city.
 */
export async function indexableLandingPaths(): Promise<string[]> {
  const subcategories = CATEGORIES.flatMap((category) => category.subcategories.map((sub) => ({ category: category.id, subcategory: sub.id })));
  const results = await searchEngine().search(subcategories.map((target) => countQuery(target, "citySlug")));
  const paths: string[] = [];
  const categoryCities = new Map<string, Map<string, number>>();
  const categoryTotals = new Map<string, number>();
  subcategories.forEach((target, index) => {
    const cities = Object.entries(results[index]?.facetDistribution?.citySlug ?? {}).filter(([, count]) => count > 0);
    const total = cities.reduce((sum, [, count]) => sum + count, 0);
    categoryTotals.set(target.category, (categoryTotals.get(target.category) ?? 0) + total);
    const perCity = categoryCities.get(target.category) ?? new Map<string, number>();
    for (const [city, count] of cities) {
      perCity.set(city, (perCity.get(city) ?? 0) + count);
      if (count >= SEO_MIN_LISTINGS) paths.push(seoPath({ ...target, city }));
    }
    categoryCities.set(target.category, perCity);
    if (total >= SEO_MIN_LISTINGS) paths.push(seoPath(target));
  });
  for (const category of CATEGORIES) {
    if ((categoryTotals.get(category.id) ?? 0) >= SEO_MIN_LISTINGS) paths.push(seoPath({ category: category.id }));
    for (const [city, count] of categoryCities.get(category.id) ?? []) {
      if (count >= SEO_MIN_LISTINGS) paths.push(seoPath({ category: category.id, city }));
    }
  }
  return paths.sort();
}

async function listingEntries(shard: number): Promise<string[]> {
  const entries: string[] = [];
  const documents = searchEngine().documents<Pick<SearchDocument, "slugId" | "updatedAt">>({
    filter: { field: "sitemapShard", op: "eq", value: shard },
    fields: ["slugId", "updatedAt"],
    pageSize: DOCUMENTS_PAGE,
    max: SITEMAP_LISTINGS_MAX,
  });
  let listings = 0;
  for await (const page of documents) {
    for (const doc of page) {
      if (listings >= SITEMAP_LISTINGS_MAX) return entries;
      if (!doc.slugId) continue;
      listings += 1;
      entries.push(...urlEntries(`/annonce/${doc.slugId}`, doc.updatedAt));
    }
  }
  return entries;
}

/** The admin procedures guide (guide-demarches G1): its home and rubrics, always indexable. */
const GUIDE_PATHS = ["/demarches", ...GUIDE_RUBRICS.map((rubric) => `/demarches/${rubric}`)];

/** XML of a sitemap file, or null for a 404 (unknown file, empty shard, not production). */
export async function buildSitemapFile(file: string, env: ServerEnv = serverEnv()): Promise<string | null> {
  if (env.APP_ENV !== "prod") return null;
  const parsed = parseSitemapFile(file);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "index":
      return sitemapIndex(["pages.xml", ...(await listingShards()).map((shard) => `listings-${shard}.xml`)]);
    case "pages":
      return urlset([...urlEntries(""), ...GUIDE_PATHS.flatMap((path) => urlEntries(path)), ...(await indexableLandingPaths()).flatMap((path) => urlEntries(path))]);
    case "listings": {
      const entries = await listingEntries(parsed.shard);
      return entries.length > 0 ? urlset(entries) : null;
    }
  }
}
