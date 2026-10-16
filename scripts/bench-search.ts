// Search latency benchmark (design D24, §10 "p95 < 300 ms"): seeds N synthetic listings into a
// throwaway index `listings_bench_<random>` (the app's settings), then replays /api/search-like
// requests (main query + À la Une query in one multi-search: words, filters, criteria, radius,
// sorts, facets) and prints p50/p95/p99 per kind. The index is deleted at the end (--keep keeps it).
// Needs MEILI_URL and MEILI_SEARCH_KEY + MEILI_INDEX_KEY (or MEILI_MASTER_KEY for both).
//
//   node scripts/bench-search.ts [--docs 20000] [--requests 400] [--concurrency 4] [--fail-above-ms 300] [--keep]

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { EngineQuery, FilterExpr, SearchDocument, SortSpec } from "../src/lib/search/types.ts";
import { registerSrcResolver } from "./search-setup.ts";

/** Deterministic PRNG (mulberry32): the same data and queries on every run. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

const WORDS = [
  "appartement", "villa", "studio", "terrain", "voiture", "dacia", "logan", "golf", "clio", "peugeot", "206", "diesel",
  "iphone", "samsung", "galaxy", "pc", "portable", "ordinateur", "canapé", "salon", "marocain", "table", "chaise", "lit",
  "frigo", "machine", "caftan", "takchita", "babouches", "vélo", "moto", "scooter", "mouton", "chat", "chien", "cours",
  "chi9a", "tomobil", "tlaja", "7anout", "شقة", "سيارة", "هاتف", "ثلاجة", "صالون", "كراء", "للبيع", "neuf", "occasion",
  "propre", "urgent", "meublé", "climatisation", "parking", "jardin", "piscine", "garantie", "facture", "original",
];

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      docs: { type: "string", default: "20000" },
      requests: { type: "string", default: "400" },
      concurrency: { type: "string", default: "4" },
      "fail-above-ms": { type: "string" },
      keep: { type: "boolean", default: false },
    },
  });
  const docCount = Number(args.docs);
  const requestCount = Number(args.requests);
  const concurrency = Number(args.concurrency);
  if (![docCount, requestCount, concurrency].every((n) => Number.isInteger(n) && n > 0)) throw new Error("--docs, --requests and --concurrency take positive integers");
  const url = process.env.MEILI_URL;
  const master = process.env.MEILI_MASTER_KEY;
  const searchKey = process.env.MEILI_SEARCH_KEY ?? master;
  const indexKey = process.env.MEILI_INDEX_KEY ?? master;
  if (!url || !searchKey || !indexKey) throw new Error("set MEILI_URL and MEILI_SEARCH_KEY + MEILI_INDEX_KEY (or MEILI_MASTER_KEY)");

  registerSrcResolver();
  const { CATEGORIES, CRITERIA } = await import("../src/config/categories.ts");
  const { CITIES } = await import("../src/config/regions.ts");
  const { MeiliEngine } = await import("../src/lib/search/meili.ts");
  const { attributeField, sitemapShardOf } = await import("../src/lib/search/types.ts");

  const random = prng(20261016);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const now = Date.now();
  const subcategories = CATEGORIES.flatMap((category) => category.subcategories);
  const weightedCities = CITIES.flatMap((city) => Array.from({ length: Math.max(1, Math.round(Math.log10(city.population + 10))) * (city.major ? 4 : 1) }, () => city));

  const docs: SearchDocument[] = Array.from({ length: docCount }, (_, i) => {
    const sub = pick(subcategories);
    const city = pick(weightedCities);
    const id = `b${i.toString(36).padStart(6, "0")}`;
    const title = Array.from({ length: 3 + Math.floor(random() * 4) }, () => pick(WORDS)).join(" ");
    const doc: SearchDocument = {
      id,
      slugId: `annonce-${id}`,
      title,
      description: Array.from({ length: 20 + Math.floor(random() * 60) }, () => pick(WORDS)).join(" "),
      categoryText: `${sub.categoryId} ${sub.id}`,
      placeText: `${city.nameFr} ${city.nameAr}`,
      attrsText: "",
      categoryId: sub.categoryId,
      subcategoryId: sub.id,
      regionCode: city.regionCode,
      citySlug: city.slug,
      sellerType: random() < 0.15 ? "pro" : "individual",
      sellerPublicId: "abcdefghjk",
      priceNegotiable: random() < 0.2,
      isDonation: random() < 0.02,
      hasPhoto: random() < 0.9,
      photoCount: 1 + Math.floor(random() * 8),
      sortAt: now - Math.floor(random() * 60 * 86_400_000),
      updatedAt: now - Math.floor(random() * 60 * 86_400_000),
      sitemapShard: sitemapShardOf(id),
      isBumped: random() < 0.03,
      _geo: { lat: city.lat, lng: city.lng },
      version: 1,
    };
    if (random() < 0.9) doc.price = Math.floor(10 ** (2 + random() * 4));
    if (random() < 0.05) doc.featuredUntil = now + 86_400_000;
    if (random() < 0.3) doc.district = pick(["maarif", "gauthier", "agdal", "hay riad", "centre ville", "guéliz"]);
    for (const criterion of sub.criteria) {
      const def = CRITERIA[criterion.id as keyof typeof CRITERIA];
      if (!def || def.type === "text") continue;
      if (def.type === "number") doc[attributeField(def.id)] = Math.floor((def.min ?? 0) + random() * Math.min(1000, (def.max ?? 1000) - (def.min ?? 0)));
      else if (def.type === "boolean") doc[attributeField(def.id)] = random() < 0.5;
      else if (def.options?.length) doc[attributeField(def.id)] = def.type === "multiselect" ? [pick(def.options), pick(def.options)] : pick(def.options);
    }
    return doc;
  });

  const index = `listings_bench_${randomBytes(3).toString("hex")}`;
  const engine = new MeiliEngine({ url, searchKey, indexKey, index, readTimeoutMs: 10_000, taskTimeoutMs: 600_000 });
  const started = performance.now();
  await engine.upsert(docs);
  console.log(`Indexed ${docCount} documents into ${index} in ${((performance.now() - started) / 1000).toFixed(1)} s`);

  type Kind = "browse" | "text" | "text+filter+sort" | "geo" | "criteria" | "facets";
  const kinds: Kind[] = ["browse", "text", "text+filter+sort", "geo", "criteria", "facets"];
  const build = (kind: Kind): EngineQuery[] => {
    const sub = pick(subcategories);
    const city = pick(weightedCities);
    const category: FilterExpr = { field: "categoryId", op: "eq", value: sub.categoryId };
    const words = Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(WORDS)).join(" ");
    const recent: SortSpec[] = [{ field: "sortAt", dir: "desc" }];
    let main: EngineQuery;
    switch (kind) {
      case "browse":
        main = { q: "", filter: { and: [category, { field: "citySlug", op: "eq", value: city.slug }] }, sort: recent, page: 1, hitsPerPage: 24, facets: ["subcategoryId"] };
        break;
      case "text":
        main = { q: words, page: 1 + Math.floor(random() * 3), hitsPerPage: 24, facets: ["categoryId", "subcategoryId"] };
        break;
      case "text+filter+sort":
        main = { q: words, filter: { and: [category, { field: "price", op: "lte", value: 50_000 }] }, sort: [{ field: "price", dir: "asc" }], page: 1, hitsPerPage: 24 };
        break;
      case "geo":
        main = { q: random() < 0.5 ? words : "", filter: { geoRadius: { lat: city.lat, lng: city.lng, meters: pick([5, 10, 20, 50, 100]) * 1000 } }, sort: [{ geoPoint: { lat: city.lat, lng: city.lng }, dir: "asc" }], page: 1, hitsPerPage: 24 };
        break;
      case "criteria": {
        const filters: FilterExpr[] = [{ field: "subcategoryId", op: "eq", value: sub.id }];
        for (const criterion of sub.criteria.slice(0, 2)) {
          const def = CRITERIA[criterion.id as keyof typeof CRITERIA];
          if (def?.type === "number") filters.push({ field: attributeField(def.id), op: "gte", value: def.min ?? 0 });
          else if ((def?.type === "select" || def?.type === "multiselect") && def.options?.length) filters.push({ field: attributeField(def.id), op: "in", values: [pick(def.options), pick(def.options)] });
        }
        main = { q: "", filter: { and: filters }, sort: recent, page: 1, hitsPerPage: 24, facets: ["district"] };
        break;
      }
      case "facets":
        main = { q: random() < 0.5 ? words : "", filter: { field: "regionCode", op: "eq", value: city.regionCode }, page: 1, hitsPerPage: 24, facets: ["categoryId", "subcategoryId", "citySlug", "district"] };
        break;
    }
    const featured: EngineQuery = { q: "", filter: { and: [category, { field: "featuredUntil", op: "gt", value: now }] }, page: 1, hitsPerPage: 20, fields: ["id"] };
    return [main, featured];
  };

  const plan = Array.from({ length: requestCount }, (_, i) => {
    const kind = kinds[i % kinds.length] as Kind;
    return { kind, queries: build(kind) };
  });
  const timings = new Map<Kind | "all", number[]>();
  const record = (kind: Kind | "all", ms: number) => {
    const list = timings.get(kind) ?? [];
    list.push(ms);
    timings.set(kind, list);
  };
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      const item = plan[next];
      next += 1;
      if (!item) break;
      const t0 = performance.now();
      await engine.search(item.queries);
      const ms = performance.now() - t0;
      record(item.kind, ms);
      record("all", ms);
    }
  };
  // Warm-up (not measured): cold caches would only measure the page cache.
  for (const kind of kinds) await engine.search(build(kind));
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`\n${requestCount} requests (main + À la Une), concurrency ${concurrency}, client round trip in ms:`);
  console.log("kind".padEnd(20), "n".padStart(5), "p50".padStart(8), "p95".padStart(8), "p99".padStart(8), "max".padStart(8));
  for (const [kind, values] of [...timings].sort(([a], [b]) => (a === "all" ? 1 : b === "all" ? -1 : 0))) {
    const sorted = [...values].sort((a, b) => a - b);
    const row = [percentile(sorted, 50), percentile(sorted, 95), percentile(sorted, 99), sorted.at(-1) ?? 0].map((ms) => ms.toFixed(1).padStart(8));
    console.log(kind.padEnd(20), String(sorted.length).padStart(5), ...row);
  }
  const all = [...(timings.get("all") ?? [])].sort((a, b) => a - b);
  const p95 = percentile(all, 95);

  if (!args.keep) await engine.deleteIndex();
  const limit = args["fail-above-ms"] === undefined ? undefined : Number(args["fail-above-ms"]);
  if (limit !== undefined && p95 > limit) throw new Error(`p95 ${p95.toFixed(1)} ms is above ${limit} ms`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]bench-search\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`bench-search: ${(error as Error).message}`);
    process.exit(1);
  });
}
