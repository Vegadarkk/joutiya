import { z } from "@/lib/zod";
import { DEFAULT_LEGAL, type LegalConfig } from "@/config/legal";

// Quotas per seller type and Pro plan (architecture §8, design D5) and option prices (phase 7
// design §5). Live values will come from Firestore `config/pricing` (admin-edited, journaled); this
// file holds the schema and the defaults.
// Phase 3 publishes individuals only; phase 7 opens Pro accounts before launch (owner, 2026-10-16). Listing lifetime (TTL 60 d, purge 12 months) is legal data and
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

/**
 * Launch offer (owner decision Q13, 2026-10-16): while sales are closed, verified Pros get the
 * quotas and storefront of `plan` for free, without its monthly credits. An admin sets `endsAt`
 * (ISO date) when `salesEnabled` flips, at least `noticeDays` later; Pros without a subscription
 * are downgraded then.
 */
export const launchOfferSchema = z
  .object({
    active: z.boolean(),
    plan: z.enum(["essentiel", "business"]),
    noticeDays: z.number().int().min(0).max(90),
    endsAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type LaunchOffer = z.infer<typeof launchOfferSchema>;

/**
 * Paid listing options of the MVP (architecture §8, phase 7 design §5), in credits (1 credit =
 * 1 MAD TTC): the immediate bump and À la Une for 7 or 30 days. Vehicles and real estate cost more.
 */
export const OPTION_IDS = ["bump", "featured7", "featured30"] as const;
export type OptionId = (typeof OPTION_IDS)[number];

/** Top-level categories priced at the higher tier (spec §8 "Véhicules et Immobilier"). */
export const PREMIUM_OPTION_CATEGORIES: readonly string[] = ["vehicules", "immobilier"];

/** Days of À la Une each option adds. */
export const FEATURED_DAYS: Readonly<Record<Exclude<OptionId, "bump">, number>> = { featured7: 7, featured30: 30 };

const credits = z.number().int().min(1).max(10_000);
const optionPriceSchema = z.object({ standard: credits, premiumCat: credits }).strict();
export const optionPricesSchema = z.object({ bump: optionPriceSchema, featured7: optionPriceSchema, featured30: optionPriceSchema }).strict();
export type OptionPrices = z.infer<typeof optionPricesSchema>;

export const pricingConfigSchema = z
  .object({
    individual: listingQuotasSchema,
    pro: z.object({ none: listingQuotasSchema, essentiel: listingQuotasSchema, business: listingQuotasSchema, premium: listingQuotasSchema }).strict(),
    /** Days a Pro keeps its quotas after a failed payment (§5 lifecycle). */
    graceDays: z.number().int().min(0).max(60),
    launchOffer: launchOfferSchema,
    options: optionPricesSchema,
  })
  .strict();
export type PricingConfig = z.infer<typeof pricingConfigSchema>;

export const DEFAULT_PRICING: PricingConfig = {
  individual: { activeListings: 20, photosPerListing: 10, listingsPerDay: 5 },
  pro: {
    // Verified Pro without a subscription and outside the launch offer (offer ended, or expired
    // subscription): publishes nothing new as a Pro.
    none: { activeListings: 0, photosPerListing: 20, listingsPerDay: 0 },
    essentiel: { activeListings: 50, photosPerListing: 20, listingsPerDay: 25 },
    business: { activeListings: 250, photosPerListing: 20, listingsPerDay: 100 },
    premium: { activeListings: null, photosPerListing: 20, listingsPerDay: null },
  },
  graceDays: 7,
  launchOffer: { active: true, plan: "essentiel", noticeDays: 30, endsAt: null },
  options: { bump: { standard: 10, premiumCat: 20 }, featured7: { standard: 29, premiumCat: 59 }, featured30: { standard: 79, premiumCat: 149 } },
};

export type Seller = { type: "individual" } | { type: "pro"; plan: ProPlan };

/** Quotas of a seller; a Pro's plan comes from `subscriptions/pro_{proId}` (never from the claims). */
export function listingQuotas(seller: Seller, config: PricingConfig = DEFAULT_PRICING): ListingQuotas {
  return seller.type === "pro" ? config.pro[seller.plan] : config.individual;
}

/** True while the launch offer applies at `now` (active and `endsAt` unset or in the future). */
export function launchOfferOpen(offer: LaunchOffer, now: Date): boolean {
  return offer.active && (offer.endsAt === null || Date.parse(offer.endsAt) > now.getTime());
}

/** Price in credits of `option` for a listing of `categoryId` (the server's config, never the client's). */
export function optionPrice(option: OptionId, categoryId: string | undefined, config: PricingConfig = DEFAULT_PRICING): number {
  const tier = categoryId !== undefined && PREMIUM_OPTION_CATEGORIES.includes(categoryId) ? "premiumCat" : "standard";
  return config.options[option][tier];
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
