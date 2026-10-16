import { describe, expect, it } from "vitest";
import { DEFAULT_AI, aiConfigSchema, resolveAiConfig } from "@/config/ai";
import { DEFAULT_LEGAL } from "@/config/legal";
import { DEFAULT_PRICING, PRO_PLANS, listingLifetime, listingQuotas, pricingConfigSchema, resolvePricingConfig, withinQuota } from "@/config/pricing";

describe("config/pricing", () => {
  it("holds the D5 quotas and the §8 plans", () => {
    expect(pricingConfigSchema.strict().safeParse(DEFAULT_PRICING).success).toBe(true);
    expect(DEFAULT_PRICING.individual).toEqual({ activeListings: 20, photosPerListing: 10, listingsPerDay: 5 });
    expect(DEFAULT_PRICING.pro.essentiel.activeListings).toBe(50);
    expect(DEFAULT_PRICING.pro.business.activeListings).toBe(250);
    expect(DEFAULT_PRICING.pro.premium.activeListings).toBeNull();
    for (const plan of PRO_PLANS) expect(DEFAULT_PRICING.pro[plan].photosPerListing).toBe(20);
    expect(DEFAULT_PRICING.graceDays).toBe(7);
  });

  it("resolves quotas per seller and compares against them", () => {
    expect(listingQuotas({ type: "individual" })).toEqual(DEFAULT_PRICING.individual);
    expect(listingQuotas({ type: "pro", plan: "business" })).toEqual(DEFAULT_PRICING.pro.business);
    expect(listingQuotas({ type: "pro", plan: "none" }).activeListings).toBe(0);
    expect(withinQuota(20, 19)).toBe(true);
    expect(withinQuota(20, 20)).toBe(false);
    expect(withinQuota(null, 1_000_000)).toBe(true);
    expect(withinQuota(0, 0)).toBe(false);
  });

  it("reads the listing lifetime from the legal configuration (no duplicate constant)", () => {
    expect(listingLifetime()).toEqual({ ttlDays: DEFAULT_LEGAL.listingTtlDays, purgeMonths: DEFAULT_LEGAL.listingPurgeMonths });
    expect(listingLifetime()).toEqual({ ttlDays: 60, purgeMonths: 12 });
    expect(listingLifetime({ listingTtlDays: 30, listingPurgeMonths: 6 })).toEqual({ ttlDays: 30, purgeMonths: 6 });
  });

  it("overrides the defaults with a stored document and reports an invalid one", () => {
    expect(resolvePricingConfig(null)).toEqual({ config: DEFAULT_PRICING, errors: [] });
    const stored = resolvePricingConfig({ individual: { activeListings: 30, photosPerListing: 12, listingsPerDay: 5 } });
    expect(stored.errors).toEqual([]);
    expect(stored.config.individual.activeListings).toBe(30);
    expect(stored.config.pro).toEqual(DEFAULT_PRICING.pro);
    const bad = resolvePricingConfig({ individual: { activeListings: -1, photosPerListing: 10, listingsPerDay: 5 }, extra: true });
    expect(bad.config).toBe(DEFAULT_PRICING);
    expect(bad.errors.some((e) => e.startsWith("individual.activeListings"))).toBe(true);
    // Zod 4 reports unrecognized keys on the root path, naming the key in the message.
    expect(bad.errors.some((e) => e.startsWith("config/pricing") && e.includes("extra"))).toBe(true);
  });
});

describe("config/ai", () => {
  it("holds the D7 and D8 thresholds", () => {
    expect(aiConfigSchema.safeParse(DEFAULT_AI).success).toBe(true);
    expect(DEFAULT_AI).toEqual({ nsfw: { rejectAt: 0.85, reviewAt: 0.6 }, face: { minConfidence: 0.6 }, risk: { reviewAt: 60 } });
  });

  it("keeps the review threshold under the reject threshold and scores in range", () => {
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI, nsfw: { rejectAt: 0.5, reviewAt: 0.7 } }).success).toBe(false);
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI, nsfw: { rejectAt: 1.5, reviewAt: 0.7 } }).success).toBe(false);
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI, face: { minConfidence: -0.1 } }).success).toBe(false);
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI, risk: { reviewAt: 60.5 } }).success).toBe(false);
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI, agent: {} }).success).toBe(false);
  });

  it("overrides the defaults with a stored document and reports an invalid one", () => {
    expect(resolveAiConfig(undefined)).toEqual({ config: DEFAULT_AI, errors: [] });
    const stored = resolveAiConfig({ face: { minConfidence: 0.75 } });
    expect(stored).toEqual({ config: { ...DEFAULT_AI, face: { minConfidence: 0.75 } }, errors: [] });
    const bad = resolveAiConfig({ nsfw: { rejectAt: 0.3, reviewAt: 0.6 } });
    expect(bad.config).toBe(DEFAULT_AI);
    expect(bad.errors).toEqual(["nsfw.reviewAt: reviewAt must not exceed rejectAt"]);
  });
});
