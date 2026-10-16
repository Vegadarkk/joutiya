import { describe, expect, it } from "vitest";
import { SUBCATEGORY_IDS, subcategoryById } from "@/config/categories";
import { PRICE_OUTLIER_FACTOR, PRICE_RANGES, isPriceOutlier, priceRange } from "@/config/price-ranges";

describe("price ranges", () => {
  it("covers every subcategory except divers/autres, with coherent integer MAD bounds", () => {
    for (const id of SUBCATEGORY_IDS) {
      if (id === "autres") {
        expect(priceRange(id)).toBeUndefined();
        continue;
      }
      const range = priceRange(id);
      expect(range, id).toBeDefined();
      expect(Number.isInteger(range?.min) && Number.isInteger(range?.max), id).toBe(true);
      expect(range?.min, id).toBeGreaterThan(0);
      expect(range?.max, id).toBeGreaterThan(range?.min ?? 0);
    }
    for (const id of Object.keys(PRICE_RANGES)) expect(subcategoryById(id), id).toBeDefined();
    expect(PRICE_OUTLIER_FACTOR).toBeGreaterThan(1);
  });

  it("flags prices outside the envelope by the factor, and symbolic zero prices", () => {
    expect(isPriceOutlier(95_000, "voitures")).toBe(false);
    expect(isPriceOutlier(5_000, "voitures")).toBe(false);
    expect(isPriceOutlier(4_999, "voitures")).toBe(true);
    expect(isPriceOutlier(6_000_000, "voitures")).toBe(false);
    expect(isPriceOutlier(6_000_001, "voitures")).toBe(true);
    expect(isPriceOutlier(0, "voitures")).toBe(true);
    expect(isPriceOutlier(2, "livres")).toBe(false);
    expect(isPriceOutlier(1, "livres")).toBe(true);
    expect(isPriceOutlier(500, "voitures", 100)).toBe(false);
    expect(isPriceOutlier(1_000_000, "autres")).toBe(false);
    expect(isPriceOutlier(5, "unknown-sub")).toBe(false);
    expect(isPriceOutlier(Number.NaN, "voitures")).toBe(false);
  });
});
