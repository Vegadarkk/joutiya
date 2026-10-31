import { z } from "@/lib/zod";
import { DEFAULT_LEGAL, type LegalConfig } from "@/config/legal";

// Quotas per seller type and Pro plan (architecture §8, design D5), option prices and credit packs
// (phase 7 design §5, §6). Live values will come from Firestore `config/pricing` (admin-edited, journaled); this
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

/**
 * Credit packs sold through RevenueCat Web Billing (phase 7 design §6): Consumable products, one per
 * pack and currency. `paid` credits match the price (1 credit = 1 MAD TTC), `bonus` credits come on
 * top (a discount, out of the taxable base). `productId` is the RevenueCat product identifier (the
 * webhook's `product_id`, same in sandbox and production), `packageId` the package of the purchase
 * link's offering. The EUR grid waits on the owner: only MAD packs by default.
 */
export const PACK_CURRENCIES = ["MAD", "EUR"] as const;
export type PackCurrency = (typeof PACK_CURRENCIES)[number];

const rcIdentifier = z.string().regex(/^[A-Za-z0-9._]{1,100}$/);
export const creditPackSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/),
    currency: z.enum(PACK_CURRENCIES),
    /** Price paid, in minor units of `currency` (centimes). RevenueCat's MAD minimum is 8.99. */
    priceMinor: z.number().int().min(899).max(10_000_000),
    paid: credits,
    bonus: z.number().int().min(0).max(10_000),
    productId: rcIdentifier,
    packageId: rcIdentifier,
  })
  .strict();
export type CreditPack = z.infer<typeof creditPackSchema>;

export const creditPacksSchema = z
  .array(creditPackSchema)
  .max(12)
  .refine((packs) => new Set(packs.map((pack) => pack.id)).size === packs.length, "pack ids must be unique")
  .refine((packs) => new Set(packs.map((pack) => pack.productId)).size === packs.length, "pack product ids must be unique");

/**
 * Pro plans sold by Stripe Checkout (phase 7 design §7): price excluding tax in MAD centimes per
 * interval (yearly = 10 months), the monthly grant (plan credits, not cumulative, and À la Une
 * allowance), the RevenueCat entitlement that carries the plan (`lookup_key`, RevenueCat is the
 * source of truth of the subscription) and the Stripe Price of each interval. Stripe ids differ per
 * environment: each Firestore project's config/pricing holds its own (none by default: the
 * checkout answers unavailable until they are set). `stripeTaxRate` is the manual Tax Rate of
 * Moroccan VAT applied to every line (its inclusive or exclusive mode is set in Stripe).
 */
export const PAID_PLANS = ["essentiel", "business"] as const;
export type PaidPlanId = (typeof PAID_PLANS)[number];
export const PLAN_INTERVALS = ["monthly", "yearly"] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

const stripePriceId = z.string().regex(/^price_[A-Za-z0-9]{1,100}$/);
export const planSchema = z
  .object({
    priceMinor: z.object({ monthly: z.number().int().min(100).max(100_000_000), yearly: z.number().int().min(100).max(1_000_000_000) }).strict(),
    credits: z.number().int().min(0).max(10_000),
    featured: z.number().int().min(0).max(100),
    entitlement: rcIdentifier,
    stripePrices: z.object({ monthly: stripePriceId.optional(), yearly: stripePriceId.optional() }).strict(),
  })
  .strict();
export type PlanConfig = z.infer<typeof planSchema>;

export const plansSchema = z
  .object({
    essentiel: planSchema,
    business: planSchema,
    stripeTaxRate: z.string().regex(/^txr_[A-Za-z0-9]{1,100}$/).optional(),
    /** Customer Portal configuration of scripts/stripe-setup.ts (plan switch, cancel at period end). */
    stripePortalConfiguration: z.string().regex(/^bpc_[A-Za-z0-9]{1,100}$/).optional(),
  })
  .strict()
  .refine((plans) => plans.essentiel.entitlement !== plans.business.entitlement, "plan entitlements must differ");
export type PlansConfig = z.infer<typeof plansSchema>;

/**
 * Pass Boutique (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §1): `days` of a
 * plan's quotas and storefront for one payment, no subscription, no renewal. Paid by Stripe Checkout
 * in `payment` mode (`stripePrice`: a one-time Price, per environment, none by default: the checkout
 * answers unavailable). `credits` are the plan credits granted once, lost at the end of the pass. A
 * pass bought during a pass extends it, up to `maxAheadDays` ahead of today.
 */
export const passSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/),
    plan: z.enum(PAID_PLANS),
    days: z.number().int().min(1).max(90),
    priceMinor: z.number().int().min(100).max(100_000_000),
    credits: z.number().int().min(0).max(10_000),
    maxAheadDays: z.number().int().min(1).max(366),
    stripePrice: stripePriceId.optional(),
  })
  .strict()
  .refine((pass) => pass.days <= pass.maxAheadDays, "a pass cannot last longer than maxAheadDays");
export type PassConfig = z.infer<typeof passSchema>;

export const passesSchema = z
  .array(passSchema)
  .max(4)
  .refine((passes) => new Set(passes.map((pass) => pass.id)).size === passes.length, "pass ids must be unique");

export const pricingConfigSchema = z
  .object({
    individual: listingQuotasSchema,
    pro: z.object({ none: listingQuotasSchema, essentiel: listingQuotasSchema, business: listingQuotasSchema, premium: listingQuotasSchema }).strict(),
    /** Days a Pro keeps its quotas after a failed payment (§5 lifecycle). */
    graceDays: z.number().int().min(0).max(60),
    launchOffer: launchOfferSchema,
    options: optionPricesSchema,
    packs: creditPacksSchema,
    plans: plansSchema,
    passes: passesSchema,
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
  packs: [
    // 30 / 100 / 200 / 500 MAD, bonus 0 / 10 / 15 / 20 % (owner, 2026-10-31; was 50 / 100 / 250).
    { id: "mad_30", currency: "MAD", priceMinor: 3_000, paid: 30, bonus: 0, productId: "joutiya_credits_30_mad", packageId: "credits_30_mad" },
    { id: "mad_100", currency: "MAD", priceMinor: 10_000, paid: 100, bonus: 10, productId: "joutiya_credits_100_mad", packageId: "credits_100_mad" },
    { id: "mad_200", currency: "MAD", priceMinor: 20_000, paid: 200, bonus: 30, productId: "joutiya_credits_200_mad", packageId: "credits_200_mad" },
    { id: "mad_500", currency: "MAD", priceMinor: 50_000, paid: 500, bonus: 100, productId: "joutiya_credits_500_mad", packageId: "credits_500_mad" },
  ],
  plans: {
    essentiel: { priceMinor: { monthly: 24_900, yearly: 249_000 }, credits: 30, featured: 0, entitlement: "essentiel", stripePrices: {} },
    business: { priceMinor: { monthly: 59_000, yearly: 590_000 }, credits: 100, featured: 4, entitlement: "business", stripePrices: {} },
  },
  // 299 MAD HT for 30 days, above a month of Essentiel (249) so the subscription stays the better
  // deal (owner, 2026-10-31; was 249 since 2026-10-28).
  passes: [{ id: "boutique30", plan: "essentiel", days: 30, priceMinor: 29_900, credits: 30, maxAheadDays: 90 }],
};

/** The pass sold as `id`, if the config lists it. */
export function passById(id: string, config: PricingConfig = DEFAULT_PRICING): PassConfig | undefined {
  return config.passes.find((pass) => pass.id === id);
}

/** Plan carried by a RevenueCat entitlement `lookup_key`, if any. */
export function planOfEntitlement(lookupKey: string, config: PricingConfig = DEFAULT_PRICING): PaidPlanId | undefined {
  return PAID_PLANS.find((plan) => config.plans[plan].entitlement === lookupKey);
}

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

/** The pack sold as RevenueCat product `productId`, if the config lists it. */
export function packByProductId(productId: string, config: PricingConfig = DEFAULT_PRICING): CreditPack | undefined {
  return config.packs.find((pack) => pack.productId === productId);
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
