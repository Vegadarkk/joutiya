import { describe, expect, it } from "vitest";
import { isSelected, locationName, locationOf, locationOptions, optionKey, optionValue, regionOfCity, sameLocation } from "@/components/search/location";

// Location choices of the search (lot L3b, D7): whole country, region or city.

describe("locationOptions", () => {
  it("starts with the whole country, then the major cities", () => {
    const options = locationOptions("", "fr");
    expect(options[0]).toEqual({ kind: "all" });
    expect(options.slice(1).every((option) => option.kind === "city")).toBe(true);
    expect(options).toContainEqual({ kind: "city", slug: "casablanca" });
    expect(options.length).toBe(11);
  });

  it("lists matching regions before matching cities, in both scripts", () => {
    const options = locationOptions("casa", "fr");
    expect(options[0]).toEqual({ kind: "region", code: "06" });
    expect(options).toContainEqual({ kind: "city", slug: "casablanca" });
    expect(locationOptions("الشرق", "ar")[0]).toEqual({ kind: "region", code: "02" });
    expect(locationOptions("Tetouan", "fr")).toContainEqual({ kind: "city", slug: "tetouan" });
    expect(locationOptions("zzzz", "fr")).toEqual([]);
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
