import { describe, expect, it } from "vitest";
import { committedOption, isSelected, locationName, locationOf, locationOptions, optionKey, optionValue, regionOfCity, sameLocation } from "@/components/search/location";

// Location choices of the search (lot L3b, D7): whole country, region or city.

describe("locationOptions", () => {
  it("starts with the whole country, then the major cities", () => {
    const options = locationOptions("", "fr");
    expect(options[0]).toEqual({ kind: "all" });
    expect(options.slice(1).every((option) => option.kind === "city")).toBe(true);
    expect(options).toContainEqual({ kind: "city", slug: "casablanca" });
    expect(options.length).toBe(11);
  });

  it("lists matching regions with the cities, in both scripts", () => {
    const options = locationOptions("casa", "fr");
    expect(options).toContainEqual({ kind: "region", code: "06" });
    expect(options).toContainEqual({ kind: "city", slug: "casablanca" });
    expect(locationOptions("الشرق", "ar")[0]).toEqual({ kind: "region", code: "02" });
    expect(locationOptions("Souss", "fr")[0]).toEqual({ kind: "region", code: "09" });
    expect(locationOptions("Tetouan", "fr")).toContainEqual({ kind: "city", slug: "tetouan" });
    expect(locationOptions("zzzz", "fr")).toEqual([]);
  });

  it("puts a city named by the typed text first, its region right after (Enter picks the city)", () => {
    const cases: [string, "fr" | "ar", string, string][] = [
      ["Casablanca", "fr", "casablanca", "06"],
      ["casa", "fr", "casablanca", "06"],
      ["Rabat", "fr", "rabat", "04"],
      ["Marrakech", "fr", "marrakech", "07"],
      ["Tanger", "fr", "tanger", "01"],
      ["Fès", "fr", "fes", "03"],
      ["الدار البيضاء", "ar", "casablanca", "06"],
      ["Casablanca", "ar", "casablanca", "06"],
    ];
    for (const [query, locale, slug, region] of cases) {
      const options = locationOptions(query, locale);
      expect(options[0], query).toEqual({ kind: "city", slug });
      expect(options.findIndex((option) => option.kind === "region" && option.code === region), query).toBe(1);
    }
  });
});

describe("committedOption", () => {
  const typed = locationOptions("Rabat", "fr");

  it("commits the first option of typed text, or the highlighted one", () => {
    expect(committedOption("Rabat", typed, 0)).toEqual({ kind: "city", slug: "rabat" });
    expect(committedOption("Rabat", typed, -1)).toEqual({ kind: "city", slug: "rabat" });
    expect(committedOption("Rabat", typed, 1)).toEqual(typed[1]);
  });

  it("commits the whole country for an emptied field", () => {
    expect(committedOption("", locationOptions("", "fr"), -1)).toEqual({ kind: "all" });
    expect(committedOption("  ", locationOptions("  ", "fr"), -1)).toEqual({ kind: "all" });
  });

  it("commits nothing without typing or without a match", () => {
    expect(committedOption(null, locationOptions("", "fr"), -1)).toBeNull();
    expect(committedOption("zzzz", locationOptions("zzzz", "fr"), 0)).toBeNull();
  });
});

describe("location values", () => {
  it("reads the place of a search, the city winning over its region", () => {
    expect(locationOf({ city: "rabat", region: "04" })).toEqual({ city: "rabat" });
    expect(locationOf({ region: "04" })).toEqual({ region: "04" });
    expect(locationOf({ city: "nowhere", region: "99" })).toEqual({});
  });

  it("compares places", () => {
    expect(sameLocation({ city: "rabat" }, { city: "rabat", region: "04" })).toBe(true);
    expect(sameLocation({ city: "rabat" }, { region: "04" })).toBe(false);
    expect(sameLocation({}, { region: undefined })).toBe(true);
    expect(sameLocation({ region: "01" }, { region: "02" })).toBe(false);
  });

  it("maps options to values, keys and the selected state", () => {
    expect(optionValue({ kind: "all" })).toEqual({});
    expect(optionValue({ kind: "region", code: "04" })).toEqual({ region: "04" });
    expect(optionValue({ kind: "city", slug: "rabat" })).toEqual({ city: "rabat" });
    expect(optionKey({ kind: "region", code: "04" })).toBe("r-04");
    expect(optionKey({ kind: "city", slug: "rabat" })).toBe("c-rabat");
    expect(isSelected({ kind: "all" }, {})).toBe(true);
    expect(isSelected({ kind: "region", code: "04" }, { city: "rabat", region: "04" })).toBe(false);
    expect(isSelected({ kind: "city", slug: "rabat" }, { city: "rabat" })).toBe(true);
  });

  it("names places in the page language", () => {
    expect(locationName({ city: "casablanca" }, "fr")).toBe("Casablanca");
    expect(locationName({ city: "casablanca" }, "ar")).toBe("الدار البيضاء");
    expect(locationName({ region: "02" }, "fr")).toBe("L'Oriental");
    expect(locationName({}, "fr")).toBeNull();
    expect(regionOfCity("rabat", "fr")).toBe("Rabat-Salé-Kénitra");
    expect(regionOfCity("nowhere", "fr")).toBeNull();
  });
});
