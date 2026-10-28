import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cityBySlug } from "@/config/regions";
import { normalizeQuery } from "@/lib/search/normalize";
import { CARD_FIELDS, sitemapShardOf, type EngineQuery, type FilterExpr, type SearchDocument, type SearchEngine, type SortSpec } from "@/lib/search/types";
import { DOCS, NEWEST_FIRST, NOW, searchDoc } from "./fixtures";

// Engine contract (design D1): the cases every SearchEngine adapter must pass identically. Run on
// the memory engine by the unit suite (tests/unit/search-memory.test.ts) and on both engines by
// `npm run test:search` (tests/search/engines.test.ts, Meilisearch when MEILI_URL and keys are set).

export interface ContractSetup {
  engine: SearchEngine;
  cleanup?: () => Promise<void>;
}

const casablanca = cityBySlug("casablanca");
if (!casablanca) throw new Error("casablanca missing");
const CASA = { lat: casablanca.lat, lng: casablanca.lng };
const RENTAL_TEXT = "Véhicules مركبات Location de voitures كراء السيارات";

export function engineContract(name: string, setup: () => Promise<ContractSetup>): void {
  describe(`${name} engine contract`, () => {
    let engine: SearchEngine;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      ({ engine, cleanup } = await setup());
      await engine.upsert(DOCS);
    }, 120_000);

    afterAll(async () => {
      await cleanup?.();
    }, 60_000);

    const query = async (input: Partial<EngineQuery> = {}) => {
      const [result] = await engine.search([{ q: "", page: 1, hitsPerPage: 50, ...input }]);
      if (!result) throw new Error("no result");
      return result;
    };
    const ids = async (input: Partial<EngineQuery> = {}) => (await query({ fields: ["id"], ...input })).hits.map((hit) => hit.id);
    const set = async (input: Partial<EngineQuery> = {}) => (await ids(input)).sort();
    const text = (q: string, input: Partial<EngineQuery> = {}) => set({ q: normalizeQuery(q), ...input });

    describe("browse and pagination", () => {
      it("returns every document newest first without words", async () => {
        const result = await query({ fields: ["id"] });
        expect(result.hits.map((hit) => hit.id)).toEqual(NEWEST_FIRST);
        expect(result.totalHits).toBe(DOCS.length);
        expect(result.totalPages).toBe(1);
        expect(result.page).toBe(1);
        expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      });

      it("pages with page and hitsPerPage", async () => {
        const first = await query({ hitsPerPage: 5, fields: ["id"] });
        expect(first.hits.map((hit) => hit.id)).toEqual(NEWEST_FIRST.slice(0, 5));
        expect(first.totalPages).toBe(3);
        const last = await query({ hitsPerPage: 5, page: 3, fields: ["id"] });
        expect(last.hits.map((hit) => hit.id)).toEqual(NEWEST_FIRST.slice(10));
        const beyond = await query({ hitsPerPage: 5, page: 4, fields: ["id"] });
        expect(beyond.hits).toEqual([]);
        expect(beyond.totalHits).toBe(DOCS.length);
        const count = await query({ hitsPerPage: 0 });
        expect(count.hits).toEqual([]);
        expect(count.totalHits).toBe(DOCS.length);
        expect(count.totalPages).toBe(0);
      });

      it("retrieves the card fields by default and only the asked fields otherwise", async () => {
        const { hits } = await query({ filter: { field: "id", op: "eq", value: "v1" } });
        const v1 = DOCS[0] as SearchDocument;
        expect(hits).toHaveLength(1);
        expect(Object.keys(hits[0] ?? {}).sort()).toEqual(CARD_FIELDS.filter((field) => v1[field] !== undefined).sort());
        expect(hits[0]).toMatchObject({ id: "v1", slugId: v1.slugId, price: 75_000, citySlug: "casablanca", sellerType: "individual", sortAt: v1.sortAt, isBumped: false });
        const custom = await query({ filter: { field: "id", op: "eq", value: "v1" }, fields: ["id", "citySlug", "updatedAt"] });
        expect(custom.hits).toEqual([{ id: "v1", citySlug: "casablanca", updatedAt: v1.updatedAt }]);
      });

      it("runs several queries in one call", async () => {
        const results = await engine.search([
          { q: "", page: 1, hitsPerPage: 2, fields: ["id"] },
          { q: "", page: 1, hitsPerPage: 10, fields: ["id"], filter: { field: "featuredUntil", op: "gt", value: NOW } },
        ]);
        expect(results.map((result) => result.hits.map((hit) => hit.id))).toEqual([NEWEST_FIRST.slice(0, 2), ["v2"]]);
      });
    });

    describe("text", () => {
      it("matches words in every searchable field, every word required", async () => {
        expect(await text("logan")).toEqual(["v1"]);
        expect(await text("LOGAN")).toEqual(["v1"]);
        expect(await text("dacia diesel")).toEqual(["v1"]);
        expect(await text("diesel")).toEqual(["v1", "v2"]);
        expect(await text("lumineux")).toEqual(["i1"]);
        expect(await text("maarif")).toEqual(["i1", "v1"]);
        expect(await text("dacia volkswagen")).toEqual([]);
      });

      it("keeps models and numbers whole", async () => {
        expect(await text("golf 7")).toEqual(["v2"]);
        expect(await text("206")).toEqual(["v3"]);
        expect(await text("iphone 13")).toEqual(["e1"]);
        expect(await text("2008")).toEqual([]);
      });

      it("folds accents and matches the last word as a prefix", async () => {
        expect(await text("canape")).toEqual(["m1"]);
        expect(await text("mathematiques")).toEqual(["s1"]);
        expect(await text("volksw")).toEqual(["v2"]);
        expect(await text("iph")).toEqual(["e1", "e2"]);
      });

      it("tolerates typos on long words but not on the first letter", async () => {
        expect(await text("volkswagn")).toEqual(["v2"]);
        expect(await text("mathematique")).toEqual(["s1"]);
        // A wrong first letter costs two typos: out of a 6-letter word's budget.
        expect(await text("kanape")).toEqual([]);
      });

      it("handles Arabic: letter variants and the article", async () => {
        expect(await text("شقه")).toEqual(["i1", "i2"]);
        expect(await text("الشقة")).toEqual(["i1", "i2"]);
        expect(await text("البحر")).toEqual(["i2"]);
        expect(await text("بحر")).toEqual(["i2"]);
        expect(await text("ال")).toEqual([]);
      });

      it("expands Darija, French and Arabic spellings through the synonyms", async () => {
        expect(await text("tomobil")).toEqual(["v1", "v2", "v3"]);
        expect(await text("appart")).toEqual(["i1", "i2"]);
        expect(await text("chi9a")).toEqual(["i1", "i2"]);
        expect(await text("casa")).toEqual(["a1", "e2", "i1", "i2", "i3", "m2", "v1"]);
        expect(await text("الدار البيضاء")).toEqual(["a1", "e2", "i1", "i2", "i3", "m2", "v1"]);
      });

      it("never expands guarded spellings into place names", async () => {
        expect(await text("maison")).toEqual(["m1", "m2"]);
        expect(await text("neuf")).toEqual([]);
      });

      it("matches some words with the last strategy", async () => {
        expect(await text("dacia zzzz")).toEqual([]);
        expect(await text("dacia zzzz", { matchingStrategy: "last" })).toEqual(["v1"]);
      });
    });

    describe("filters", () => {
      const filtered = (filter: FilterExpr) => set({ filter });

      it("compares strings, numbers and booleans", async () => {
        expect(await filtered({ field: "categoryId", op: "eq", value: "vehicules" })).toEqual(["v1", "v2", "v3"]);
        expect(await filtered({ field: "citySlug", op: "in", values: ["rabat", "tanger"] })).toEqual(["e1", "m1", "v2"]);
        expect(await filtered({ and: [{ field: "price", op: "gte", value: 30_000 }, { field: "price", op: "lte", value: 100_000 }] })).toEqual(["v1", "v3"]);
        expect(await filtered({ not: { field: "price", op: "exists" } })).toEqual(["m1", "m2"]);
        expect(await filtered({ field: "isDonation", op: "eq", value: true })).toEqual(["m2"]);
        expect(await filtered({ field: "hasPhoto", op: "eq", value: false })).toEqual(["m1"]);
        expect(await filtered({ field: "sellerType", op: "eq", value: "pro" })).toEqual(["s1", "v2"]);
        expect(await filtered({ field: "condition", op: "in", values: ["like_new", "very_good"] })).toEqual(["e1"]);
        expect(await filtered({ field: "district", op: "eq", value: "maarif" })).toEqual(["i1", "v1"]);
        expect(await filtered({ field: "featuredUntil", op: "gt", value: NOW })).toEqual(["v2"]);
        expect(await filtered({ field: "sortAt", op: "gt", value: NOW - 2.5 * 86_400_000 })).toEqual(["i1", "v1"]);
        expect(await filtered({ field: "id", op: "in", values: ["v1", "e1", "missing"] })).toEqual(["e1", "v1"]);
        expect(await filtered({ field: "sitemapShard", op: "eq", value: sitemapShardOf("v1") })).toContain("v1");
        expect(await filtered({ or: [] })).toEqual([]);
        expect(await filtered({ and: [] })).toHaveLength(DOCS.length);
      });

      it("filters criteria fields, multiselect arrays included", async () => {
        expect(await filtered({ field: "a_car_brand", op: "in", values: ["dacia", "peugeot"] })).toEqual(["v1", "v3"]);
        expect(await filtered({ field: "a_year", op: "gte", value: 2016 })).toEqual(["v1", "v2"]);
        expect(await filtered({ field: "a_amenities", op: "eq", value: "parking" })).toEqual(["i1"]);
        expect(await filtered({ field: "a_furnished", op: "eq", value: true })).toEqual(["i2"]);
        expect(await filtered({ field: "a_head_count", op: "lt", value: 2 })).toEqual(["a1"]);
      });

      it("filters car rentals free on every asked day, by minimum rental and freshness", async () => {
        const rental = (id: string, extra: Partial<SearchDocument>, minDays?: number) => ({
          ...searchDoc({ id, title: `Dacia Logan ${id}`, categoryId: "vehicules", subcategoryId: "location-voitures", categoryText: RENTAL_TEXT, citySlug: "casablanca", price: 250, sellerType: "pro", daysAgo: 1, attributes: minDays ? { "min-rental-days": minDays } : {} }),
          ...extra,
        });
        await engine.upsert([rental("r1", { rentUnavailableDays: [20_400, 20_401], rentFreshUntil: NOW + 86_400_000 }, 3), rental("r2", { rentFreshUntil: NOW - 86_400_000 })]);
        try {
          const scope: FilterExpr = { field: "subcategoryId", op: "eq", value: "location-voitures" };
          const free = (days: number[], duration: number): FilterExpr => ({
            and: [
              scope,
              { not: { field: "rentUnavailableDays", op: "in", values: days } },
              { or: [{ field: "a_min_rental_days", op: "lte", value: duration }, { not: { field: "a_min_rental_days", op: "exists" } }] },
            ],
          });
          expect(await filtered(free([20_401, 20_402, 20_403], 3))).toEqual(["r2"]);
          expect(await filtered(free([20_402, 20_403, 20_404], 2))).toEqual(["r2"]);
          expect(await filtered(free([20_402, 20_403, 20_404, 20_405], 3))).toEqual(["r1", "r2"]);
          expect(await filtered({ and: [scope, { field: "rentFreshUntil", op: "gt", value: NOW }] })).toEqual(["r1"]);
          expect(await filtered({ and: [scope, { not: { field: "rentFreshUntil", op: "gt", value: NOW } }] })).toEqual(["r2"]);
        } finally {
          await engine.remove(["r1", "r2"]);
        }
      });

      it("treats string equality as case-insensitive", async () => {
        expect(await filtered({ field: "citySlug", op: "eq", value: "CASABLANCA" })).toEqual(["e2", "i1", "m2", "v1"]);
      });

      it("keeps quotes inside values (no injection)", async () => {
        expect(await filtered({ field: "citySlug", op: "eq", value: 'x" OR categoryId = "vehicules' })).toEqual([]);
        expect(await filtered({ field: "district", op: "eq", value: "maarif\\" })).toEqual([]);
      });

      it("filters a radius around a point", async () => {
        expect(await filtered({ geoRadius: { ...CASA, meters: 10_000 } })).toEqual(["e2", "i1", "m2", "v1"]);
        expect(await filtered({ geoRadius: { ...CASA, meters: 30_000 } })).toEqual(["e2", "i1", "i2", "m2", "v1"]);
        expect(await filtered({ and: [{ geoRadius: { ...CASA, meters: 30_000 } }, { field: "categoryId", op: "eq", value: "immobilier" }] })).toEqual(["i1", "i2"]);
      });

      it("refuses unknown fields", async () => {
        await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1, filter: { field: "ownerUid", op: "eq", value: "x" } }])).rejects.toThrow();
      });
    });

    describe("sorts", () => {
      const sorted = (sort: SortSpec[], filter?: FilterExpr, q = "") => ids({ sort, ...(filter ? { filter } : {}), q });
      const cars: FilterExpr = { field: "categoryId", op: "eq", value: "vehicules" };

      it("sorts by price and date, documents without price last", async () => {
        expect(await sorted([{ field: "price", dir: "asc" }], cars)).toEqual(["v3", "v1", "v2"]);
        expect(await sorted([{ field: "price", dir: "desc" }], cars)).toEqual(["v2", "v1", "v3"]);
        expect(await sorted([{ field: "sortAt", dir: "asc" }], cars)).toEqual(["v3", "v2", "v1"]);
        expect((await sorted([{ field: "price", dir: "asc" }])).slice(-2).sort()).toEqual(["m1", "m2"]);
        expect((await sorted([{ field: "price", dir: "desc" }])).slice(-2).sort()).toEqual(["m1", "m2"]);
      });

      it("sorts by distance, newest first between equal distances", async () => {
        const order = await sorted([{ geoPoint: CASA, dir: "asc" }]);
        expect(order.slice(0, 4)).toEqual(["v1", "i1", "e2", "m2"]);
        expect(order[4]).toBe("i2");
      });

      it("applies the sort to the words' matches", async () => {
        expect(await sorted([{ field: "price", dir: "asc" }], undefined, "iphone")).toEqual(["e2", "e1"]);
        expect(await sorted([{ field: "price", dir: "desc" }], undefined, "iphone")).toEqual(["e1", "e2"]);
      });
    });

    describe("facets", () => {
      it("counts the values of the matching documents", async () => {
        const result = await query({ facets: ["categoryId", "citySlug"], hitsPerPage: 0 });
        expect(result.facetDistribution?.categoryId).toEqual({ vehicules: 3, immobilier: 3, electronique: 2, "maison-jardin": 2, animaux: 1, services: 1 });
        expect(result.facetDistribution?.citySlug).toEqual({ casablanca: 4, rabat: 2, marrakech: 2, "el-jadida": 2, mohammedia: 1, tanger: 1 });
        const casa = await query({ facets: ["district", "sitemapShard"], filter: { field: "citySlug", op: "eq", value: "casablanca" }, hitsPerPage: 0 });
        expect(casa.facetDistribution?.district).toEqual({ maarif: 2, "ain diab": 1 });
        const shards = Object.values(casa.facetDistribution?.sitemapShard ?? {}).reduce((sum, count) => sum + count, 0);
        expect(shards).toBe(4);
        const words = await query({ q: "iphone", facets: ["subcategoryId"], hitsPerPage: 0 });
        expect(words.facetDistribution?.subcategoryId).toEqual({ "telephones-objets-connectes": 2 });
      });

      it("refuses facets on non-filterable fields", async () => {
        await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1, facets: ["title"] }])).rejects.toThrow();
      });
    });

    describe("documents and versions", () => {
      const collect = async <T>(iterable: AsyncIterable<T[]>) => {
        const pages: T[][] = [];
        for await (const page of iterable) pages.push(page);
        return pages;
      };

      it("lists documents by filter with the asked fields, in pages", async () => {
        const shard = sitemapShardOf("v1");
        const pages = await collect(engine.documents<Pick<SearchDocument, "id" | "slugId" | "updatedAt">>({ filter: { field: "sitemapShard", op: "eq", value: shard }, fields: ["id", "slugId", "updatedAt"] }));
        const expected = DOCS.filter((doc) => doc.sitemapShard === shard);
        expect(pages.flat().map((doc) => doc.id).sort()).toEqual(expected.map((doc) => doc.id).sort());
        for (const doc of pages.flat()) expect(Object.keys(doc).sort()).toEqual(["id", "slugId", "updatedAt"]);
        const paged = await collect(engine.documents({ fields: ["id"], pageSize: 5 }));
        expect(paged.map((page) => page.length)).toEqual([5, 5, 2]);
        const capped = await collect(engine.documents({ fields: ["id"], pageSize: 5, max: 7 }));
        expect(capped.flat()).toHaveLength(7);
      });

      it("lists every stored version", async () => {
        const pages = await collect(engine.versions());
        expect(pages.flat().sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(DOCS.map((doc) => ({ id: doc.id, version: doc.version })).sort((a, b) => (a.id < b.id ? -1 : 1)));
      });

      it("replaces and removes documents", async () => {
        const v1 = DOCS[0] as SearchDocument;
        await engine.upsert([{ ...v1, title: "Dacia Sandero Stepway", version: 2 }]);
        expect(await text("sandero")).toEqual(["v1"]);
        expect(await text("logan")).toEqual([]);
        await engine.upsert([v1]);
        await engine.upsert([searchDoc({ id: "tmp1", title: "Objet temporaire", categoryId: "divers", subcategoryId: "autres", categoryText: "Divers", citySlug: "rabat", daysAgo: 0 })]);
        expect(await text("temporaire")).toEqual(["tmp1"]);
        await engine.remove(["tmp1", "never-indexed"]);
        expect(await text("temporaire")).toEqual([]);
        expect(await text("logan")).toEqual(["v1"]);
      });

      it("reports itself healthy", async () => {
        expect(await engine.healthy()).toBe(true);
      });
    });

    describe("result window", () => {
      it("reports the exhaustive total but serves pages up to 1200 hits", async () => {
        const extra = Array.from({ length: 1250 }, (_, i) => searchDoc({ id: `bulk${i}`, title: `Lot ${i}`, categoryId: "divers", subcategoryId: "autres", categoryText: "Divers", citySlug: "rabat", daysAgo: 30 }));
        await engine.upsert(extra);
        try {
          const filter: FilterExpr = { field: "categoryId", op: "eq", value: "divers" };
          const first = await query({ filter, hitsPerPage: 24, fields: ["id"] });
          expect(first.totalHits).toBe(1250);
          expect(first.totalPages).toBe(50);
          const last = await query({ filter, hitsPerPage: 24, page: 50, fields: ["id"] });
          expect(last.hits).toHaveLength(24);
          const beyond = await query({ filter, hitsPerPage: 24, page: 51, fields: ["id"] });
          expect(beyond.hits).toEqual([]);
        } finally {
          await engine.remove(extra.map((doc) => doc.id));
        }
      }, 120_000);
    });
  });
}
