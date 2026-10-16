import { describe, expect, it } from "vitest";
import { assertFacets, assertFilter, InvalidFilterError, quoteFilterValue, toMeiliFilter } from "@/lib/search/filters";

describe("quoteFilterValue", () => {
  it("double-quotes and escapes backslashes before quotes", () => {
    expect(quoteFilterValue("maarif")).toBe('"maarif"');
    expect(quoteFilterValue('Aït "Test"')).toBe('"Aït \\"Test\\""');
    expect(quoteFilterValue("back\\slash")).toBe('"back\\\\slash"');
    expect(quoteFilterValue('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteFilterValue("O'Neil")).toBe('"O\'Neil"');
  });

  it("cannot be closed early to inject an operator", () => {
    const quoted = quoteFilterValue('x" OR sellerType = "pro');
    expect(quoted).toBe('"x\\" OR sellerType = \\"pro"');
    // Every inner quote is escaped: the literal ends at the last character only.
    expect(quoted.slice(1, -1).replace(/\\./g, "")).not.toContain('"');
  });

  it("turns control characters into spaces", () => {
    expect(quoteFilterValue("a\nb\tc\u0000d")).toBe('"a b c d"');
  });
});

describe("toMeiliFilter", () => {
  it("translates every operator", () => {
    expect(toMeiliFilter({ field: "citySlug", op: "eq", value: "casablanca" })).toBe('citySlug = "casablanca"');
    expect(toMeiliFilter({ field: "isDonation", op: "eq", value: true })).toBe("isDonation = true");
    expect(toMeiliFilter({ field: "sitemapShard", op: "eq", value: 3 })).toBe("sitemapShard = 3");
    expect(toMeiliFilter({ field: "id", op: "in", values: ["a1", "b2"] })).toBe('id IN ["a1", "b2"]');
    expect(toMeiliFilter({ field: "price", op: "gte", value: 100 })).toBe("price >= 100");
    expect(toMeiliFilter({ field: "price", op: "lt", value: 2.5 })).toBe("price < 2.5");
    expect(toMeiliFilter({ field: "featuredUntil", op: "gt", value: 1_760_000_000_000 })).toBe("featuredUntil > 1760000000000");
    expect(toMeiliFilter({ field: "price", op: "exists" })).toBe("price EXISTS");
    expect(toMeiliFilter({ geoRadius: { lat: 33.57, lng: -7.59, meters: 20_000.4 } })).toBe("_geoRadius(33.57, -7.59, 20000)");
    expect(toMeiliFilter({ field: "a_car_brand", op: "in", values: ["dacia", "renault"] })).toBe('a_car_brand IN ["dacia", "renault"]');
    expect(toMeiliFilter({ field: "a_year", op: "gte", value: 2015 })).toBe("a_year >= 2015");
  });

  it("nests AND, OR and NOT with parentheses", () => {
    const filter = toMeiliFilter({
      and: [
        { field: "categoryId", op: "eq", value: "vehicules" },
        { or: [{ field: "price", op: "lte", value: 5000 }, { not: { field: "price", op: "exists" } }] },
      ],
    });
    expect(filter).toBe('(categoryId = "vehicules") AND ((price <= 5000) OR (NOT (price EXISTS)))');
  });

  it("simplifies empty and single-element groups", () => {
    expect(toMeiliFilter({ and: [] })).toBe("");
    expect(toMeiliFilter({ and: [{ field: "hasPhoto", op: "eq", value: true }] })).toBe("hasPhoto = true");
    expect(toMeiliFilter({ or: [] })).toBe("id IN []");
    expect(toMeiliFilter({ or: [{ and: [] }, { field: "hasPhoto", op: "eq", value: true }] })).toBe("");
    expect(toMeiliFilter({ not: { and: [] } })).toBe("id IN []");
  });

  it("refuses unknown fields, comparisons on equality fields and bad numbers", () => {
    expect(() => toMeiliFilter({ field: "ownerUid", op: "eq", value: "x" })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ field: "title", op: "eq", value: "x" })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ field: "a_model", op: "eq", value: "x" })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ field: "citySlug", op: "gt", value: 3 })).toThrow(/comparisons/);
    expect(() => toMeiliFilter({ field: "_geo", op: "exists" })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ field: "price", op: "gt", value: Number.NaN })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ field: "price", op: "gt", value: 1e21 })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ geoRadius: { lat: 95, lng: 0, meters: 10 } })).toThrow(InvalidFilterError);
    expect(() => toMeiliFilter({ geoRadius: { lat: 30, lng: 0, meters: 0 } })).toThrow(InvalidFilterError);
    expect(() => assertFilter({ and: [{ field: "nope", op: "exists" }] })).toThrow(InvalidFilterError);
  });

  it("checks facet names", () => {
    expect(() => assertFacets(["categoryId", "subcategoryId", "district", "citySlug", "sitemapShard", "price"])).not.toThrow();
    expect(() => assertFacets(["title"])).toThrow(InvalidFilterError);
    expect(() => assertFacets(["_geo"])).toThrow(InvalidFilterError);
  });
});
