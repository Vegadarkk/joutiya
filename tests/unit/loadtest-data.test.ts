import { describe, expect, it } from "vitest";
import { criteriaSchema } from "@/config/categories";
import { publishedListingSchema, userSchema } from "@/lib/db/schemas";
import { LISTING_ID_PATTERN, parseSlugId } from "@/lib/listings/ids";
import {
  LOADTEST_INDEX_ONLY,
  LOADTEST_LISTINGS,
  LOADTEST_SELLER_UID,
  LOADTEST_TITLE_PREFIX,
  loadtestId,
  loadtestIds,
  loadtestListing,
  loadtestPagePaths,
  loadtestSearchQueries,
  loadtestSeller,
} from "@/lib/loadtest/data";
import { toSearchDocument } from "@/lib/search/document";
import { parseSeedCli, removeSeed, seed, type SeedTarget } from "../../scripts/seed-loadtest";

// Load test data set (D17): valid listings, stable ids and URLs, and a seed that removes exactly
// what it wrote.

const NOW = new Date("2026-11-01T10:00:00Z");

describe("load test ids", () => {
  it("are valid listing ids, unique, in two series", () => {
    const { firestore, indexOnly } = loadtestIds();
    expect(firestore).toHaveLength(LOADTEST_LISTINGS);
    expect(indexOnly).toHaveLength(LOADTEST_INDEX_ONLY);
    const all = [...firestore, ...indexOnly];
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => LISTING_ID_PATTERN.test(id))).toBe(true);
    expect(firestore.every((id) => id.startsWith("zz")) && indexOnly.every((id) => id.startsWith("zy"))).toBe(true);
    expect(loadtestId("zz", 0)).toBe("zzaaaaaa");
  });
});

describe("load test listings", () => {
  it("are published listings with valid criteria, the same on every run", () => {
    for (const n of [0, 1, 777, LOADTEST_LISTINGS - 1]) {
      const { id, ...doc } = loadtestListing("zz", n, NOW);
      expect(publishedListingSchema.safeParse(doc).error?.issues ?? []).toEqual([]);
      expect(criteriaSchema(doc.subcategoryId as string).safeParse(doc.attributes).success).toBe(true);
      expect(doc.title.startsWith(LOADTEST_TITLE_PREFIX)).toBe(true);
      expect(doc.ownerUid).toBe(LOADTEST_SELLER_UID);
      expect(parseSlugId(doc.slugId as string)?.id).toBe(id);
      expect(loadtestListing("zz", n, NOW)).toEqual({ id, ...doc });
    }
  });

  it("are indexable", () => {
    expect(toSearchDocument(loadtestListing("zy", 12, NOW), NOW)).not.toBeNull();
  });

  it("belong to a valid seller", () => {
    expect(userSchema.safeParse(loadtestSeller(NOW)).error?.issues ?? []).toEqual([]);
  });
});

describe("load test URLs", () => {
  it("lists unique page paths in every locale, shuffled the same way", () => {
    const paths = loadtestPagePaths();
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBeGreaterThan(3 * LOADTEST_LISTINGS);
    expect(paths.every((path) => /^\/(fr|ar|rif)\/(annonce|c)\//.test(path))).toBe(true);
    expect(loadtestPagePaths().slice(0, 20)).toEqual(paths.slice(0, 20));
    const { slugId } = loadtestListing("zz", 0, new Date(0));
    expect(paths).toContain(`/fr/annonce/${slugId}`);
  });

  it("builds search queries with the seeded words", () => {
    const queries = loadtestSearchQueries(200);
    expect(queries).toHaveLength(200);
    expect(queries.every((query) => new URLSearchParams(query).get("q"))).toBe(true);
    expect(loadtestSearchQueries(200)).toEqual(queries);
  });
});

describe("seed-loadtest", () => {
  function fakeTarget(): SeedTarget & { batches: number[]; docs: Map<string, unknown>; index: Set<string> } {
    const docs = new Map<string, unknown>();
    const index = new Set<string>();
    const batches: number[] = [];
    return {
      batches,
      docs,
      index,
      async write(operations) {
        batches.push(operations.length);
        for (const { path, data } of operations) {
          if (data === null) docs.delete(path);
          else docs.set(path, data);
        }
      },
      engine: {
        async upsert(documents) {
          for (const document of documents) index.add(document.id);
        },
        async remove(ids) {
          for (const id of ids) index.delete(id);
        },
      } as SeedTarget["engine"],
      log: () => undefined,
    };
  }

  it("parses its flags", () => {
    expect(parseSeedCli([])).toEqual({ remove: false, apply: false });
    expect(parseSeedCli(["--remove", "--apply"])).toEqual({ remove: true, apply: true });
    expect(() => parseSeedCli(["--all"])).toThrow();
  });

  it("writes the seller and the listings in batches of 500, indexes 50 000, then removes them all", async () => {
    const target = fakeTarget();
    expect(await seed(target, NOW)).toEqual({ documents: LOADTEST_LISTINGS + 1, indexed: LOADTEST_LISTINGS + LOADTEST_INDEX_ONLY });
    expect(Math.max(...target.batches)).toBe(500);
    expect(target.docs.has(`users/${LOADTEST_SELLER_UID}`)).toBe(true);
    expect(target.index.size).toBe(LOADTEST_LISTINGS + LOADTEST_INDEX_ONLY);
    expect(await removeSeed(target)).toEqual({ documents: LOADTEST_LISTINGS + 1, unindexed: LOADTEST_LISTINGS + LOADTEST_INDEX_ONLY });
    expect(target.docs.size).toBe(0);
    expect(target.index.size).toBe(0);
  });
});
