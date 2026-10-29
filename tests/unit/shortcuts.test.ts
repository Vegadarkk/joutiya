import { describe, expect, it } from "vitest";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { canonicalSearchParams, searchPath } from "@/lib/search/params";
import { HOLIDAY_RENTAL_SEARCH, RENT_CAR_SEARCH } from "@/lib/search/shortcuts";

// The header's shortcuts are plain strings (no zod in the browser): they must stay what the search
// serializer would produce for the same filters, and point at subcategories of the catalog.

describe("header shortcuts", () => {
  it("match the search serializer for the two rental subcategories", () => {
    expect(RENT_CAR_SEARCH).toBe(searchPath(canonicalSearchParams({ category: "vehicules", subcategory: RENTAL_SUBCATEGORY })));
    expect(HOLIDAY_RENTAL_SEARCH).toBe(searchPath(canonicalSearchParams({ category: "immobilier", subcategory: "location-vacances" })));
  });
});
