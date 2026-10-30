import { describe, expect, it } from "vitest";
import { countByCity, countBySector, directoryPath, excerptOf, filterShops, parseDirectorySegments, sectorBySegment, sortShops, type DirectoryShop } from "@/lib/pro/directory-view";

// The shop directory's pure side: path segments <-> filter, sorting, facet counts, excerpts.

function shop(over: Partial<DirectoryShop> & { proId: string }): DirectoryShop {
  return { segment: `${over.proId}-slug`, name: over.proId, excerpt: "", citySlug: "casablanca", sector: "general", example: false, certified: false, listings: 0, ...over };
}

describe("parseDirectorySegments", () => {
  it("reads nothing, a city, an activity or both in that order", () => {
    expect(parseDirectorySegments([])).toEqual({});
    expect(parseDirectorySegments(["ville", "fes"])).toEqual({ city: "fes" });
    expect(parseDirectorySegments(["activite", "agences-immobilieres"])).toEqual({ sector: "real_estate" });
    expect(parseDirectorySegments(["ville", "fes", "activite", "location-voitures"])).toEqual({ city: "fes", sector: "car_rental" });
  });

  it("refuses an unknown city or activity, a wrong order and leftovers", () => {
    expect(parseDirectorySegments(["ville", "atlantis"])).toBeNull();
    expect(parseDirectorySegments(["ville"])).toBeNull();
    expect(parseDirectorySegments(["activite", "banques"])).toBeNull();
    expect(parseDirectorySegments(["activite", "boutiques", "ville", "fes"])).toBeNull();
    expect(parseDirectorySegments(["ville", "fes", "page", "2"])).toBeNull();
    expect(parseDirectorySegments(["fes"])).toBeNull();
  });

  it("round-trips with directoryPath", () => {
    for (const filter of [{}, { city: "rabat" }, { sector: "holiday_rental" as const }, { city: "tanger", sector: "general" as const }]) {
      const path = directoryPath(filter);
      expect(path.startsWith("/boutiques")).toBe(true);
      expect(parseDirectorySegments(path.split("/").slice(2))).toEqual(filter);
    }
    expect(directoryPath({})).toBe("/boutiques");
    expect(directoryPath({ city: "fes", sector: "real_estate" })).toBe("/boutiques/ville/fes/activite/agences-immobilieres");
    expect(sectorBySegment("location-saisonniere")).toBe("holiday_rental");
    expect(sectorBySegment("general")).toBeNull();
  });
});

describe("the shops", () => {
  const shops = [
    shop({ proId: "d", name: "Zellige & Co", citySlug: "fes", listings: 2 }),
    shop({ proId: "a", name: "Atlas Immo", citySlug: "casablanca", sector: "real_estate", listings: 12 }),
    shop({ proId: "e", name: "Exemple", citySlug: "casablanca", example: true, listings: 40 }),
    shop({ proId: "b", name: "Bab Cars", citySlug: "casablanca", sector: "car_rental", listings: 0 }),
    shop({ proId: "c", name: "Épices Chaouen", citySlug: "fes", listings: 1 }),
  ];

  it("filters by city and activity", () => {
    expect(filterShops(shops, {}).map((entry) => entry.proId)).toEqual(["d", "a", "e", "b", "c"]);
    expect(filterShops(shops, { city: "fes" }).map((entry) => entry.proId)).toEqual(["d", "c"]);
    expect(filterShops(shops, { sector: "general" }).map((entry) => entry.proId)).toEqual(["d", "e", "c"]);
    expect(filterShops(shops, { city: "casablanca", sector: "general" }).map((entry) => entry.proId)).toEqual(["e"]);
    expect(filterShops(shops, { city: "rabat" })).toEqual([]);
  });

  it("sorts real shops first, then the ones with listings, then by name (accents folded)", () => {
    expect(sortShops(shops).map((entry) => entry.proId)).toEqual(["a", "c", "d", "b", "e"]);
    expect(sortShops(shops, "ar").map((entry) => entry.proId)).toEqual(["a", "c", "d", "b", "e"]);
  });

  it("counts the cities, fullest first, and every activity", () => {
    expect(countByCity(shops)).toEqual([
      { city: "casablanca", count: 3 },
      { city: "fes", count: 2 },
    ]);
    expect(countByCity([shop({ proId: "x", citySlug: "rabat" }), shop({ proId: "y", citySlug: "agadir" })])).toEqual([
      { city: "agadir", count: 1 },
      { city: "rabat", count: 1 },
    ]);
    expect(countBySector(shops)).toEqual({ general: 3, real_estate: 1, car_rental: 1, holiday_rental: 0 });
    expect(countBySector([])).toEqual({ general: 0, real_estate: 0, car_rental: 0, holiday_rental: 0 });
  });
});

describe("excerptOf", () => {
  it("keeps the first paragraph and cuts on a word", () => {
    expect(excerptOf("  Caftans et babouches.\n\nAtelier à Fès.")).toBe("Caftans et babouches.");
    expect(excerptOf("\n\n")).toBe("");
    const long = "Atelier de tissage installé à Fès depuis trois générations, tapis et couvertures en laine.";
    expect(excerptOf(long, 40)).toBe("Atelier de tissage installé à Fès depuis…");
    expect(excerptOf(long, 200)).toBe(long);
    expect(excerptOf("a".repeat(50), 20)).toBe(`${"a".repeat(20)}…`);
    expect(excerptOf("Ouvert tous les jours, sauf le dimanche.", 22)).toBe("Ouvert tous les jours…");
  });
});
