import { describe, expect, it } from "vitest";
import { haversineMeters, matchesFilter, MemoryEngine, searchTokens } from "@/lib/search/memory";
import { engineContract } from "../search/contract";
import { DOCS, searchDoc } from "../search/fixtures";

// The shared engine contract on the memory engine (the same cases run on Meilisearch in
// `npm run test:search`), then memory-only details.
engineContract("memory", async () => ({ engine: new MemoryEngine() }));

describe("searchTokens", () => {
  it("folds case, accents, Arabic letters and digits, splits the article and drops stop words", () => {
    expect(searchTokens("Canapé L'Oasis")).toEqual(["canape", "l", "oasis"]);
    expect(searchTokens("السيارة الجديدة")).toEqual(["سياره", "جديده"]);
    expect(searchTokens("ال إلكترونيات")).toEqual(["كترونيات"]);
    expect(searchTokens("golf 7 ٢٠١٩")).toEqual(["golf", "7", "2019"]);
    expect(searchTokens("chi9a")).toEqual(["chi9a"]);
    expect(searchTokens("")).toEqual([]);
  });
});

describe("MemoryEngine", () => {
  it("uses the given synonyms instead of the lexicon", async () => {
    const engine = new MemoryEngine({ synonyms: { bagnole: ["voiture"], voiture: ["bagnole"] } });
    await engine.upsert([searchDoc({ id: "x1", title: "Voiture rouge", categoryId: "vehicules", subcategoryId: "voitures", categoryText: "", citySlug: "rabat", daysAgo: 1 })]);
    const [bagnole] = await engine.search([{ q: "bagnole", page: 1, hitsPerPage: 10 }]);
    expect(bagnole?.hits.map((hit) => hit.id)).toEqual(["x1"]);
    const [tomobil] = await engine.search([{ q: "tomobil", page: 1, hitsPerPage: 10 }]);
    expect(tomobil?.hits).toEqual([]);
  });

  it("ignores multi-word Arabic synonym keys, as Meilisearch 1.55.0 does", async () => {
    const engine = new MemoryEngine({ synonyms: { "الدار البيضاء": ["casa"], casa: ["الدار البيضاء"] } });
    await engine.upsert([searchDoc({ id: "x1", title: "casa", categoryId: "divers", subcategoryId: "autres", categoryText: "", citySlug: "rabat", daysAgo: 1 })]);
    const [result] = await engine.search([{ q: "الدار البيضاء", page: 1, hitsPerPage: 10 }]);
    expect(result?.hits).toEqual([]);
  });

  it("stores copies, counts and clears", async () => {
    const engine = new MemoryEngine();
    const doc = structuredClone(DOCS[0]);
    if (!doc) throw new Error("fixture");
    await engine.upsert([doc]);
    doc.title = "changed";
    const [result] = await engine.search([{ q: "logan", page: 1, hitsPerPage: 10, fields: ["id", "title"] }]);
    expect(result?.hits).toEqual([{ id: "v1", title: DOCS[0]?.title }]);
    expect(engine.size).toBe(1);
    engine.clear();
    expect(engine.size).toBe(0);
    expect(await engine.ensureReady()).toEqual({ created: false, settingsUpdated: false });
    expect(engine.kind).toBe("memory");
  });

  it("validates paging arguments and filters like the Meilisearch adapter", async () => {
    const engine = new MemoryEngine();
    await expect(engine.search([{ q: "", page: 0, hitsPerPage: 10 }])).rejects.toThrow(RangeError);
    await expect(engine.search([{ q: "", page: 1, hitsPerPage: -1 }])).rejects.toThrow(RangeError);
    await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1, filter: { field: "citySlug", op: "gt", value: 1 } }])).rejects.toThrow(/comparisons/);
    await expect(engine.upsert([{ ...(DOCS[0] as NonNullable<(typeof DOCS)[0]>), id: "" }])).rejects.toThrow(/id/);
  });
});

describe("filter helpers", () => {
  it("computes great-circle distances", () => {
    // Casablanca -> Rabat is about 87 km.
    const meters = haversineMeters({ lat: 33.5992, lng: -7.62 }, { lat: 34.0211, lng: -6.8414 });
    expect(meters).toBeGreaterThan(85_000);
    expect(meters).toBeLessThan(89_000);
    expect(haversineMeters({ lat: 1, lng: 1 }, { lat: 1, lng: 1 })).toBe(0);
  });

  it("evaluates equality on arrays and numbers", () => {
    const doc = DOCS.find((item) => item.id === "i1");
    if (!doc) throw new Error("fixture");
    expect(matchesFilter(doc, { field: "a_amenities", op: "in", values: ["piscine", "ascenseur"] })).toBe(true);
    expect(matchesFilter(doc, { field: "price", op: "eq", value: 1_450_000 })).toBe(true);
    expect(matchesFilter(doc, { field: "price", op: "eq", value: true })).toBe(false);
    expect(matchesFilter(doc, { field: "featuredUntil", op: "exists" })).toBe(false);
  });
});
