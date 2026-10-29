import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDoc } from "../search/fixtures";
import { PriceGuideBlock } from "@/components/listing/price-guide";
import {
  comparableSpec,
  percentile,
  priceGuideApplies,
  priceStats,
  rangePosition,
  roundingStep,
  scalePosition,
  specKey,
  type PriceGuide,
} from "@/lib/price-guide/rules";
import { comparablesQuery, computePriceGuide, priceGuideCacheKey, priceGuideFor, setPriceGuideCacheForTests, subjectKey, type GuideCache, type GuideSubject } from "@/lib/price-guide/service";
import { MemoryEngine } from "@/lib/search/memory";
import type { EngineQuery, SearchEngine } from "@/lib/search/types";

// « Prix repère » (Carte vivante lot 5): the statistics, which listings get one, the comparables
// query, the widening city -> region -> Morocco, the cache, and the block in FR and AR.

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = { fr: (await import("../../messages/fr.json")).default, ar: (await import("../../messages/ar.json")).default };
  return {
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar"; namespace?: string }) =>
      createTranslator({ locale, messages: messages[locale] ?? messages.fr, namespace: namespace as never }),
  };
});

const BIKES = "Véhicules مركبات Vélos دراجات";

function bike(id: string, citySlug: string, price: number, extra: { bikeType?: string; example?: boolean; soldOut?: boolean; donation?: boolean } = {}) {
  const doc = searchDoc({
    id,
    title: `Vélo ${id}`,
    categoryId: "vehicules",
    subcategoryId: "velos",
    categoryText: BIKES,
    citySlug,
    price,
    isDonation: extra.donation ?? false,
    daysAgo: 1,
    attributes: { "bike-type": extra.bikeType ?? "enfant" },
  });
  if (extra.example) doc.isExample = true;
  if (extra.soldOut) doc.soldOut = true;
  return doc;
}

const subject = (overrides: Partial<GuideSubject> = {}): GuideSubject => ({
  id: "subject1",
  subcategoryId: "velos",
  attributes: { "bike-type": "enfant" },
  price: 450,
  isDonation: false,
  citySlug: "casablanca",
  regionCode: "06",
  ...overrides,
});

afterEach(() => setPriceGuideCacheForTests(undefined));

describe("statistics", () => {
  it("rounds readable steps", () => {
    expect(roundingStep(450)).toBe(10);
    expect(roundingStep(250)).toBe(5);
    expect(roundingStep(85_000)).toBe(1000);
    expect(roundingStep(1_450_000)).toBe(50_000);
  });

  it("interpolates percentiles", () => {
    expect(percentile([100, 200, 300, 400, 500], 0.25)).toBe(200);
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(250);
  });

  it("needs 8 comparables, drops the top and bottom 10 % and rounds outwards", () => {
    expect(priceStats([300, 350, 400, 420, 450, 480, 500])).toBeNull();
    const prices = [10, 300, 320, 350, 380, 400, 420, 450, 480, 500, 520, 9_000];
    const stats = priceStats(prices);
    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.count).toBe(12);
    // 10 and 9 000 are outliers: out of the scale.
    expect(stats.low).toBeGreaterThanOrEqual(300);
    expect(stats.high).toBeLessThanOrEqual(520);
    expect(stats.p25).toBeLessThanOrEqual(350);
    expect(stats.p75).toBeGreaterThanOrEqual(480);
    expect(stats.p25 % 10).toBe(0);
    expect(stats.p75 % 10).toBe(0);
    expect(stats.low).toBeLessThanOrEqual(stats.p25);
    expect(stats.high).toBeGreaterThanOrEqual(stats.p75);
  });

  it("places a price on the scale and against the range, never judging it", () => {
    const guide = { low: 250, high: 700, p25: 350, p75: 500 };
    expect(scalePosition(guide, 250)).toBe(0);
    expect(scalePosition(guide, 1000)).toBe(1);
    expect(scalePosition(guide, 475)).toBeCloseTo(0.5);
    expect(rangePosition(guide, 300)).toBe("below");
    expect(rangePosition(guide, 450)).toBe("within");
    expect(rangePosition(guide, 600)).toBe("above");
  });
});

describe("which listings get a guide", () => {
  it("skips donations, examples, no price, services, food, lots, livestock, night rentals and adults-only goods", () => {
    expect(comparableSpec(subject())).toMatchObject({ subcategoryId: "velos", equals: { "bike-type": "enfant" } });
    expect(comparableSpec(subject({ isDonation: true }))).toBeNull();
    expect(comparableSpec(subject({ example: true }))).toBeNull();
    expect(comparableSpec(subject({ price: null }))).toBeNull();
    expect(comparableSpec(subject({ attributes: { "bike-type": "autre" } }))).toBeNull();
    expect(priceGuideApplies("cours")).toBe(false);
    expect(priceGuideApplies("autres")).toBe(false);
    expect(priceGuideApplies("betail-moutons")).toBe(false);
    expect(priceGuideApplies("stocks-gros")).toBe(false);
    expect(priceGuideApplies("location-vacances")).toBe(false);
    expect(priceGuideApplies("inconnue")).toBe(false);
    expect(priceGuideApplies("voitures")).toBe(true);
  });

  it("compares cars by brand, model words and year band, homes by type, rooms and surface band", () => {
    const car = comparableSpec({ subcategoryId: "voitures", attributes: { "car-brand": "dacia", model: "Logan «MCV»", year: 2016, mileage: 120_000 }, price: 75_000, isDonation: false });
    expect(car).toEqual({ subcategoryId: "voitures", equals: { "car-brand": "dacia" }, ranges: { year: { min: 2015, max: 2017 } }, text: "Logan MCV" });
    const home = comparableSpec({ subcategoryId: "vente", attributes: { "property-type": "appartement", rooms: 3, surface: 100 }, price: 1_200_000, isDonation: false });
    expect(home).toMatchObject({ equals: { "property-type": "appartement", rooms: 3 }, ranges: { surface: { min: 80, max: 120 } } });
    const phone = comparableSpec({ subcategoryId: "telephones-objets-connectes", attributes: { "phone-brand": "apple", model: "iPhone 13", storage: "256-go" }, price: 7_500, isDonation: false });
    expect(phone).toMatchObject({ equals: { "phone-brand": "apple", storage: "256-go" }, text: "iPhone 13" });
    // A stable cache key, whatever the order of the criteria.
    if (car) expect(specKey(car)).toBe(specKey({ ...car, equals: { ...car.equals } }));
  });

  it("asks the engine for published comparables only, the listing itself out, 200 prices at most", () => {
    const spec = comparableSpec(subject());
    if (!spec) throw new Error("spec expected");
    const query: EngineQuery = comparablesQuery(spec, subject(), "city");
    expect(query.hitsPerPage).toBe(200);
    expect(query.fields).toEqual(["id", "price", "isExample"]);
    expect(query.filter).toEqual({
      and: [
        { field: "subcategoryId", op: "eq", value: "velos" },
        { field: "citySlug", op: "eq", value: "casablanca" },
        { field: "price", op: "gt", value: 0 },
        { field: "isDonation", op: "eq", value: false },
        { not: { field: "soldOut", op: "eq", value: true } },
        { not: { field: "id", op: "eq", value: "subject1" } },
        { field: "a_bike_type", op: "eq", value: "enfant" },
      ],
    });
    expect(JSON.stringify(comparablesQuery(spec, subject(), "region").filter)).toContain('"regionCode"');
    expect(JSON.stringify(comparablesQuery(spec, subject(), "country").filter)).not.toContain("citySlug");
  });
});

describe("computing", () => {
  const prices = [300, 320, 350, 380, 400, 420, 450, 480, 500, 520];

  it("keeps the city when it has 8 comparables, excluding examples, sold-out, donations, other types and the listing", async () => {
    const engine = new MemoryEngine();
    await engine.upsert([
      ...prices.map((price, index) => bike(`c${index}`, "casablanca", price)),
      bike("subject1", "casablanca", 450),
      bike("x1", "casablanca", 50_000, { example: true }),
      bike("x2", "casablanca", 50_000, { soldOut: true }),
      bike("x3", "casablanca", 1, { donation: true }),
      bike("x4", "casablanca", 50_000, { bikeType: "vtt" }),
    ]);
    const guide = await computePriceGuide(subject(), engine);
    expect(guide).toMatchObject({ scope: "city", place: "casablanca", count: 10 });
    expect(guide?.high).toBeLessThan(1000);
  });

  it("widens to the region, then to Morocco, and gives up below 8 everywhere", async () => {
    const engine = new MemoryEngine();
    await engine.upsert([...prices.slice(0, 3).map((price, index) => bike(`c${index}`, "casablanca", price)), ...prices.slice(3, 8).map((price, index) => bike(`m${index}`, "mohammedia", price))]);
    expect(await computePriceGuide(subject(), engine)).toMatchObject({ scope: "region", place: "06", count: 8 });
    expect(await computePriceGuide(subject({ citySlug: "rabat", regionCode: "04" }), engine)).toMatchObject({ scope: "country", place: "ma", count: 8 });
    await engine.remove(["m0"]);
    expect(await computePriceGuide(subject(), engine)).toBeNull();
  });
});

describe("cache", () => {
  function memoryCache(): GuideCache & { entries: Map<string, string> } {
    const entries = new Map<string, string>();
    return {
      entries,
      get: async (key) => entries.get(key) ?? null,
      set: async (key, value) => {
        entries.set(key, value);
      },
    };
  }

  it("serves the cached guide while the comparables stay the same, and recomputes once they change", async () => {
    const cache = memoryCache();
    setPriceGuideCacheForTests(cache);
    const engine = new MemoryEngine();
    await engine.upsert([300, 320, 350, 380, 400, 420, 450, 480, 500].map((price, index) => bike(`c${index}`, "casablanca", price)));
    const search = vi.spyOn(engine, "search");
    const first = await priceGuideFor(subject(), engine);
    expect(first?.count).toBe(9);
    expect(cache.entries.has(priceGuideCacheKey("subject1"))).toBe(true);
    expect(await priceGuideFor(subject(), engine)).toEqual(first);
    expect(search).toHaveBeenCalledTimes(1);
    // Another bike type: other comparables, a fresh computation (none here).
    expect(await priceGuideFor(subject({ attributes: { "bike-type": "vtt" } }), engine)).toBeNull();
    expect(search).toHaveBeenCalledTimes(2);
    // A listing without a guide never reaches the engine, and its absence is cached too.
    expect(await priceGuideFor(subject({ id: "don1", isDonation: true }), engine)).toBeNull();
    expect(search).toHaveBeenCalledTimes(2);
    expect(subjectKey(subject({ isDonation: true }))).toBe("-");
  });

  it("shows no guide, uncached, when the engine fails", async () => {
    const cache = memoryCache();
    setPriceGuideCacheForTests(cache);
    const broken = { kind: "memory", search: async () => Promise.reject(new Error("down")) } as unknown as SearchEngine;
    expect(await priceGuideFor(subject(), broken)).toBeNull();
    expect(cache.entries.size).toBe(0);
  });
});

describe("block", () => {
  const guide: PriceGuide = { low: 250, high: 700, p25: 350, p75: 500, count: 23, scope: "city", place: "casablanca" };

  it("says the count, the area and the range, places the price, and disclaims", async () => {
    const html = renderToStaticMarkup(await PriceGuideBlock({ guide, price: 450, locale: "fr" }));
    expect(html).toContain("Prix repère");
    expect(html).toContain("23 annonces comparables à Casablanca");
    expect(html).toContain("350 – 500");
    expect(html).toContain("dans la fourchette habituelle");
    expect(html).toContain("sans garantie");
    expect(html).toContain('data-scope="city"');
    expect(html).not.toMatch(/bon prix|trop cher/i);
    const region = renderToStaticMarkup(await PriceGuideBlock({ guide: { ...guide, scope: "region", place: "06" }, price: 800, locale: "fr" }));
    expect(region).toContain("dans la région Casablanca-Settat");
    expect(region).toContain("au-dessus de la fourchette");
    const country = renderToStaticMarkup(await PriceGuideBlock({ guide: { ...guide, scope: "country", place: "ma" }, price: 300, locale: "ar" }));
    expect(country).toContain("في المغرب");
    expect(country).toContain("السعر المرجعي");
  });
});
