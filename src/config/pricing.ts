import { z } from "@/lib/zod";
import { DEFAULT_LEGAL, type LegalConfig } from "@/config/legal";

// Quotas per seller type and Pro plan (architecture §8, design D5). Live values will come from
// Firestore `config/pricing` (admin-edited, journaled); this file holds the schema and the defaults.
// Phase 3 publishes individuals only (Pro = waitlist until phase 7): the pro branch stays here so
// the quota helper has one shape. Listing lifetime (TTL 60 d, purge 12 months) is legal data and
// lives in config/legal (`listingTtlDays`, `listingPurgeMonths`): read it through `listingLifetime`.

export const PRO_PLANS = ["none", "essentiel", "business", "premium"] as const;
export type ProPlan = (typeof PRO_PLANS)[number];

/** `null` = unlimited (Premium, "usage raisonnable"). */
const limit = z.number().int().min(0).nullable();

export const listingQuotasSchema = z
  .object({
    activeListings: limit,
    photosPerListing: z.number().int().min(1).max(50),
    listingsPerDay: limit,
  })
  .strict();
export type ListingQuotas = z.infer<typeof listingQuotasSchema>;

export const pricingConfigSchema = z
  .object({
    individual: listingQuotasSchema,
    pro: z.object({ none: listingQuotasSchema, essentiel: listingQuotasSchema, business: listingQuotasSchema, premium: listingQuotasSchema }).strict(),
    /** Days a Pro keeps its quotas after a failed payment (§5 lifecycle). */
    graceDays: z.number().int().min(0).max(60),
  })
  .strict();
export type PricingConfig = z.infer<typeof pricingConfigSchema>;

export const DEFAULT_PRICING: PricingConfig = {
  individual: { activeListings: 20, photosPerListing: 10, listingsPerDay: 5 },
  pro: {
    // Verified Pro without a subscription: owner decision pending before phase 7 (§11: `none` or
    // Essentiel offered). Until then a Pro publishes nothing as a Pro.
    none: { activeListings: 0, photosPerListing: 20, listingsPerDay: 0 },
    essentiel: { activeListings: 50, photosPerListing: 20, listingsPerDay: 25 },
    business: { activeListings: 250, photosPerListing: 20, listingsPerDay: 100 },
    premium: { activeListings: null, photosPerListing: 20, listingsPerDay: null },
  },
  graceDays: 7,
};

export type Seller = { type: "individual" } | { type: "pro"; plan: ProPlan };

/** Quotas of a seller; a Pro's plan comes from `subscriptions/pro_{proId}` (never from the claims). */
export function listingQuotas(seller: Seller, config: PricingConfig = DEFAULT_PRICING): ListingQuotas {
  return seller.type === "pro" ? config.pro[seller.plan] : config.individual;
}

/** True when `count` more fits under `quota` (`null` = unlimited). */
export function withinQuota(quota: number | null, count: number): boolean {
  return quota === null || count < quota;
}

/** Listing TTL and purge delay, from the legal configuration (defaults 60 days, 12 months). */
export function listingLifetime(legal: Pick<LegalConfig, "listingTtlDays" | "listingPurgeMonths"> = DEFAULT_LEGAL): { ttlDays: number; purgeMonths: number } {
  return { ttlDays: legal.listingTtlDays, purgeMonths: legal.listingPurgeMonths };
}

/** Firestore value over the defaults; an invalid document is reported and the defaults apply. */
export function resolvePricingConfig(stored: unknown): { config: PricingConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_PRICING, errors: [] };
  const parsed = pricingConfigSchema.safeParse({ ...DEFAULT_PRICING, ...(typeof stored === "object" ? stored : {}) });
  if (parsed.success) return { config: parsed.data, errors: [] };
  return {
    config: DEFAULT_PRICING,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "config/pricing"}: ${issue.message}`),
  };
}
