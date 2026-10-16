import { describe, expect, it } from "vitest";
import { FEATURED_HOME_SLOTS, FEATURED_POOL_SIZE, FEATURED_SEARCH_SLOTS, drawFeatured, seededRandom } from "@/lib/search/featured";

// À la Une draw (design D8): seeded per request, distinct cards, uniform over the pool.

const pool = Array.from({ length: FEATURED_POOL_SIZE }, (_, i) => `listing-${i}`);

describe("drawFeatured", () => {
  it("draws the same cards for the same seed and pool", () => {
    expect(drawFeatured(pool, FEATURED_SEARCH_SLOTS, "req-1")).toEqual(drawFeatured(pool, FEATURED_SEARCH_SLOTS, "req-1"));
    expect(drawFeatured(pool, FEATURED_HOME_SLOTS, "home")).toEqual(drawFeatured([...pool], FEATURED_HOME_SLOTS, "home"));
  });

  it("rotates the cards across seeds", () => {
    const draws = new Set(Array.from({ length: 50 }, (_, i) => drawFeatured(pool, FEATURED_SEARCH_SLOTS, `req-${i}`).join("|")));
    expect(draws.size).toBeGreaterThan(40);
  });

  it("returns distinct cards, never more than the pool, and leaves the pool untouched", () => {
    const copy = [...pool];
    const drawn = drawFeatured(pool, FEATURED_HOME_SLOTS, "seed");
    expect(drawn).toHaveLength(FEATURED_HOME_SLOTS);
    expect(new Set(drawn).size).toBe(FEATURED_HOME_SLOTS);
    expect(drawn.every((item) => pool.includes(item))).toBe(true);
    expect(pool).toEqual(copy);
    expect(drawFeatured(pool.slice(0, 3), FEATURED_HOME_SLOTS, "seed").sort()).toEqual(pool.slice(0, 3).sort());
    expect(drawFeatured(pool, 0, "seed")).toEqual([]);
    expect(drawFeatured([], 2, "seed")).toEqual([]);
    expect(drawFeatured(pool, -1, "seed")).toEqual([]);
  });

  it("gives every pooled listing about the same chance", () => {
    const hits = new Map<string, number>();
    const runs = 4000;
    for (let i = 0; i < runs; i += 1) {
      for (const item of drawFeatured(pool, FEATURED_SEARCH_SLOTS, `r${i}`)) hits.set(item, (hits.get(item) ?? 0) + 1);
    }
    const expected = (runs * FEATURED_SEARCH_SLOTS) / pool.length;
    for (const item of pool) {
      expect(hits.get(item) ?? 0).toBeGreaterThan(expected * 0.75);
      expect(hits.get(item) ?? 0).toBeLessThan(expected * 1.25);
    }
  });
});

describe("seededRandom", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = seededRandom("x");
    const b = seededRandom("x");
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom("y")()).not.toBe(seededRandom("x")());
  });
});
