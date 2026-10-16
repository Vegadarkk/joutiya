import { describe, expect, it } from "vitest";
import {
  CITIES,
  MOROCCO_BBOX,
  REGIONS,
  approximatePosition,
  cityBySlug,
  citiesOfRegion,
  regionByCode,
  searchCities,
} from "@/config/regions";
import { includesNormalized, normalizeText, tokenize } from "@/lib/text/normalize";

describe("regions dataset", () => {
  it("has the 12 regions in decree order and ~100 cities", () => {
    expect(REGIONS.map((r) => r.code)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
    expect(CITIES.length).toBe(100);
  });

  it("has unique ASCII slugs and valid references", () => {
    const slugs = new Set<string>();
    for (const city of CITIES) {
      expect(city.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slugs.has(city.slug)).toBe(false);
      slugs.add(city.slug);
      expect(regionByCode(city.regionCode)).toBeDefined();
      expect(city.nameAr).toMatch(/[؀-ۿ]/);
    }
    for (const region of REGIONS) {
      const chefLieu = cityBySlug(region.chefLieu);
      expect(chefLieu?.regionCode).toBe(region.code);
      expect(chefLieu?.major).toBe(true);
    }
  });

  it("keeps every coordinate inside the Morocco bbox", () => {
    for (const p of [...CITIES, ...REGIONS.map((r) => r.centroid)]) {
      expect(p.lat).toBeGreaterThan(MOROCCO_BBOX.south);
      expect(p.lat).toBeLessThan(MOROCCO_BBOX.north);
      expect(p.lng).toBeGreaterThan(MOROCCO_BBOX.west);
      expect(p.lng).toBeLessThan(MOROCCO_BBOX.east);
    }
  });

  it("lists major cities first within a region", () => {
    const cities = citiesOfRegion("06");
    expect(cities[0]?.slug).toBe("casablanca");
    const firstMinor = cities.findIndex((c) => !c.major);
    expect(cities.slice(firstMinor).every((c) => !c.major)).toBe(true);
  });

  it("searches accent- and script-insensitively", () => {
    expect(searchCities("tetouan", "fr")[0]?.slug).toBe("tetouan");
    expect(searchCities("Tétouan", "fr")[0]?.slug).toBe("tetouan");
    expect(searchCities("mdiq", "fr")[0]?.slug).toBe("mdiq");
    expect(searchCities("الدار", "ar")[0]?.slug).toBe("casablanca");
    expect(searchCities("casa", "ar")[0]?.slug).toBe("casablanca");
    expect(searchCities("", "fr").every((c) => c.major)).toBe(true);
    expect(searchCities("zzzz", "fr")).toEqual([]);
  });

  it("offsets the approximate marker deterministically within ~1 km", () => {
    const city = cityBySlug("rabat")!;
    const a = approximatePosition(city, "abc12345");
    const b = approximatePosition(city, "abc12345");
    const c = approximatePosition(city, "zzz99999");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const km = Math.hypot((a.lat - city.lat) * 111, (a.lng - city.lng) * 111 * Math.cos((city.lat * Math.PI) / 180));
    expect(km).toBeGreaterThan(0.3);
    expect(km).toBeLessThan(0.9);
  });
});

describe("normalizeText", () => {
  it("folds Latin accents, case and punctuation", () => {
    expect(normalizeText("  Ksar El-Kébir, M'diq!  ")).toBe("ksar el kebir mdiq");
    expect(tokenize("Béni Mellal")).toEqual(["beni", "mellal"]);
  });

  it("folds Arabic variants, diacritics and digits", () => {
    expect(normalizeText("أَلدّار ٱلبيضاء")).toBe("الدار البيضاء");
    expect(normalizeText("مكناسة ٢٠٢٤")).toBe("مكناسه 2024");
    expect(includesNormalized("Vends iPhone à Témara", "temara")).toBe(true);
    expect(includesNormalized("abc", "")).toBe(false);
  });
});
