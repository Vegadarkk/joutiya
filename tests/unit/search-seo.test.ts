import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATEGORY_IDS, SUBCATEGORY_IDS, subcategoryById } from "@/config/categories";
import { CITY_SLUGS, cityBySlug } from "@/config/regions";
import { resetServerEnv } from "@/lib/env";
import { resetSearchEngine, setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";
import { cityLinks, distanceKm, resolveSeoSegments, SEO_MIN_LISTINGS, seoCounts, seoPath, seoSearchParams, seoVerdict } from "@/lib/search/seo";
import { sitemapShardOf, type SearchDocument } from "@/lib/search/types";

// Category landing pages (design D15): segment resolution from config, thresholds, facet counts.

function doc(id: string, subcategoryId: string, citySlug: string): SearchDocument {
  const sub = subcategoryById(subcategoryId);
  const city = cityBySlug(citySlug);
  if (!sub || !city) throw new Error("fixture");
  return {
    id,
    slugId: `annonce-${id}`,
    title: "Annonce",
    description: "",
    categoryText: "",
    placeText: "",
    attrsText: "",
    categoryId: sub.categoryId,
    subcategoryId,
    regionCode: city.regionCode,
    citySlug,
    sellerType: "individual",
    sellerPublicId: "abcdefghjk",
    priceNegotiable: false,
    isDonation: false,
    hasPhoto: false,
    photoCount: 0,
    sortAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sitemapShard: sitemapShardOf(id),
    isBumped: false,
    _geo: { lat: city.lat, lng: city.lng },
    version: 1,
  };
}

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
});
afterEach(() => {
  resetSearchEngine();
  resetServerEnv();
});

describe("landing segments", () => {
  it("never lets a subcategory or category id collide with a city slug", () => {
    // The second segment is read as a subcategory first: a collision would hide that city's page.
    const cities = new Set(CITY_SLUGS);
    expect(SUBCATEGORY_IDS.filter((id) => cities.has(id))).toEqual([]);
    expect(CATEGORY_IDS.filter((id) => cities.has(id))).toEqual([]);
  });

  it("resolves category, subcategory and city paths", () => {
    expect(resolveSeoSegments("vehicules", [])).toEqual({ category: "vehicules" });
    expect(resolveSeoSegments("vehicules", ["voitures"])).toEqual({ category: "vehicules", subcategory: "voitures" });
    expect(resolveSeoSegments("vehicules", ["casablanca"])).toEqual({ category: "vehicules", city: "casablanca" });
    expect(resolveSeoSegments("vehicules", ["voitures", "casablanca"])).toEqual({ category: "vehicules", subcategory: "voitures", city: "casablanca" });
  });

  it("refuses anything outside the config before any engine call", () => {
    const refused: [string, string[]][] = [
      ["voitures", []],
      ["inconnu", []],
      ["Vehicules", []],
      ["vehicules", ["vente"]], // a subcategory of immobilier
      ["vehicules", ["atlantis"]],
      ["vehicules", ["casablanca", "voitures"]],
      ["vehicules", ["casablanca", "rabat"]],
      ["vehicules", ["voitures", "velos"]],
      ["vehicules", ["voitures", "casablanca", "x"]],
      ["vehicules", ["casablanca-settat"]], // a region, not a city
      ["vehicules", [""]],
    ];
    for (const [category, rest] of refused) expect(resolveSeoSegments(category, rest), `${category}/${rest.join("/")}`).toBeNull();
  });

  it("builds paths and the matching search scope", () => {
    const target = { category: "vehicules", subcategory: "voitures", city: "casablanca" };
    expect(seoPath(target)).toBe("/c/vehicules/voitures/casablanca");
    expect(seoPath({ category: "vehicules", city: "rabat" })).toBe("/c/vehicules/rabat");
    expect(seoPath({ category: "vehicules" })).toBe("/c/vehicules");
    expect(seoSearchParams(target)).toEqual(target);
    expect(seoSearchParams({ category: "vehicules" })).toEqual({ category: "vehicules" });
  });
});

describe("landing thresholds", () => {
  it("keeps the category page at 200, 404s empty deeper pages, noindexes thin ones", () => {
    const category = { category: "vehicules" };
    const deeper = { category: "vehicules", city: "casablanca" };
    expect(SEO_MIN_LISTINGS).toBe(3);
    expect([0, 1, 2, 3, 40].map((total) => seoVerdict(category, total))).toEqual(["noindex", "noindex", "noindex", "index", "index"]);
    expect([0, 1, 2, 3].map((total) => seoVerdict(deeper, total))).toEqual(["notFound", "noindex", "noindex", "index"]);
    expect(seoVerdict({ category: "vehicules", subcategory: "voitures" }, 0)).toBe("notFound");
  });
});

describe("city links", () => {
  it("lists the nearest cities with listings around a city, never the city itself", () => {
    const counts = { casablanca: 9, mohammedia: 2, marrakech: 5, rabat: 1, tanger: 0 };
    const links = cityLinks(counts, "casablanca");
    expect(links.map((link) => link.city.slug)).toEqual(["mohammedia", "rabat", "marrakech"]);
    expect(links[0]?.count).toBe(2);
  });

  it("lists the busiest cities without a city, capped", () => {
    const counts = { casablanca: 9, mohammedia: 2, marrakech: 5, rabat: 5 };
    expect(cityLinks(counts).map((link) => link.city.slug)).toEqual(["casablanca", "marrakech", "rabat", "mohammedia"]); // tie: larger city first
    expect(cityLinks(counts, undefined, 2)).toHaveLength(2);
  });

  it("measures great-circle distances", () => {
    const casablanca = cityBySlug("casablanca");
    const rabat = cityBySlug("rabat");
    if (!casablanca || !rabat) throw new Error("fixture");
    expect(distanceKm(casablanca, rabat)).toBeGreaterThan(80);
    expect(distanceKm(casablanca, rabat)).toBeLessThan(95);
    expect(distanceKm(casablanca, casablanca)).toBe(0);
  });
});

describe("seoCounts", () => {
  it("counts subcategories without the page's subcategory and cities without its city", async () => {
    const engine = new MemoryEngine({ synonyms: {} });
    await engine.upsert([
      doc("a2345678", "voitures", "casablanca"),
      doc("b2345678", "voitures", "casablanca"),
      doc("c2345678", "voitures", "rabat"),
      doc("d2345678", "velos", "casablanca"),
      doc("e2345678", "vente", "casablanca"),
    ]);
    setSearchEngineForTests(engine);
    await expect(seoCounts({ category: "vehicules" })).resolves.toEqual({
      subcategories: { voitures: 3, velos: 1 },
      cities: { casablanca: 3, rabat: 1 },
      total: 4,
    });
    await expect(seoCounts({ category: "vehicules", subcategory: "voitures", city: "casablanca" })).resolves.toEqual({
      subcategories: { voitures: 2, velos: 1 },
      cities: { casablanca: 2, rabat: 1 },
      total: 2,
    });
    await expect(seoCounts({ category: "vehicules", city: "rabat" })).resolves.toMatchObject({ subcategories: { voitures: 1 }, total: 1 });
    await expect(seoCounts({ category: "immobilier", subcategory: "location" })).resolves.toMatchObject({ total: 0 });
  });
});
