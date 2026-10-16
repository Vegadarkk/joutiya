import { describe, expect, it } from "vitest";
import { percentile, prng } from "../../scripts/bench-search";

describe("bench-search helpers", () => {
  it("draws the same sequence for a seed, in [0, 1)", () => {
    const a = prng(42);
    const b = prng(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBe(1000);
    expect(prng(43)()).not.toBe(values[0]);
  });

  it("takes nearest-rank percentiles", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});
