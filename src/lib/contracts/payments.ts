import { z } from "@/lib/zod";
import { LOCALES } from "@/config/site";
import { OPTION_IDS, PAID_PLANS, PLAN_INTERVALS, type OptionId, type PackCurrency, type PaidPlanId, type PlanInterval } from "@/config/pricing";

// Credits wallet, paid listing options, credit packs and Pro plans (phase 7 design §5-§7). Client-safe
// contract shared by the promote dialog, the wallet and packs pages and the routes. Prices always
// come from the server: a body names the option or the pack, and the price it saw only to be
// refused if it changed.

/** Version of the two purchase consent texts (Options.consent.* in messages/*.json, draft for legal review). */
export const OPTION_CONSENT_VERSION = "2026-10";

export const buyOptionSchema = z
  .object({
    optionId: z.enum(OPTION_IDS),
    /** Client-generated per attempt: a retried request debits once. */
    requestId: z.uuid(),
    /** Credits the buyer agreed to pay (the offer's price, 0 when the plan's allowance covers it): any other cost is refused. */
    expectedCost: z.number().int().min(0).max(1_000_000),
    /** "J'accepte les CGV ... droit de rétractation de 14 jours." */
    acceptTerms: z.literal(true),
    /** "Je demande l'exécution immédiate ... je perdrai mon droit de rétractation ..." */
    immediateExecutionConsent: z.literal(true),
  })
  .strict();
export type BuyOptionInput = z.infer<typeof buyOptionSchema>;

export interface WalletSummary {
  /** Purchased credits (may be negative after a refund: the wallet is then frozen). */
  balance: number;
  /** The plan's credits of the current period (spent first, not cumulative). */
  planCredits: number;
  planCreditsResetsAt: string | null;
  /** À la Une 7 days included in the plan for the current period. */
  featuredAllowance: number;
  frozen: boolean;
}

export interface OptionOffer {
  id: OptionId;
  /** Credits for this listing's category. */
  price: number;
  /** Days of À la Une added (featured options). */
  days: number | null;
  /** Paid with the plan's À la Une allowance instead of credits. */
  coveredByAllowance: boolean;
  /** Plan credits + balance (or the allowance) cover it and the wallet is not frozen. */
  affordable: boolean;
  /** A bump right after a sort is refused until then (the listing is at the top already). */
  availableAt: string | null;
}

/** GET /api/listings/{id}/options: what the promote dialog shows. */
export interface ListingOptionsResponse {
  salesOpen: boolean;
  /** Not published, hidden by moderation: nothing can be bought for it. */
  promotable: boolean;
  /** The subcategory has paid options at all (a job seeker's ad has none: `boost_not_allowed`). */
  allowed: boolean;
  options: OptionOffer[];
  wallet: WalletSummary;
  boosts: { bumpedAt: string | null; featuredUntil: string | null };
  /** End of the listing's publication: À la Une days past it are lost unless the listing is renewed. */
  expiresAt: string | null;
  consentVersion: string;
}

/** POST /api/listings/{id}/options. */
export interface BuyOptionResponse {
  optionId: OptionId;
  /** A retried request answered from its first execution (nothing debited twice). */
  replayed: boolean;
  cost: { planCredits: number; credits: number; allowance: number };
  wallet: WalletSummary;
  boosts: { bumpedAt: string | null; featuredUntil: string | null };
}

export const LEDGER_PAGE_SIZE = 20;

export interface LedgerEntryView {
  id: string;
  reason: "purchase" | "option" | "plan_grant" | "refund" | "refund_reversed" | "admin_adjust";
  /** Change of the purchased balance. */
  delta: number;
  planCreditsDelta: number;
  featuredAllowanceDelta: number;
  balanceAfter: number;
  optionId: OptionId | null;
  /** The listing an option was bought for. */
  listingId: string | null;
  at: string;
}

/** GET /api/wallet[?after=entryId]. */
export interface WalletResponse {
  salesOpen: boolean;
  /** Whose credits: the member's own, or the shop's (`pro_{proId}`, its owner only). */
  account: "personal" | "shop";
  wallet: WalletSummary;
  entries: LedgerEntryView[];
  next: string | null;
}

/** Version of the pack purchase consent text (Packs.consent in messages/*.json, draft for legal review). */
export const PACK_CONSENT_VERSION = "2026-10";

/** Office des Changes: online payments abroad with a Moroccan card, per person and calendar year (IGOC art. 121). */
export const MOROCCAN_CARD_YEARLY_CAP_MAD = 20_000;

export const checkoutPackSchema = z
  .object({
    packId: z.string().regex(/^[a-z0-9_]{1,40}$/),
    /** Price the buyer saw, minor units: another price is refused (the page reloads). */
    expectedPriceMinor: z.number().int().min(0).max(10_000_000),
    /** "J'accepte les CGV ... crédits non utilisés remboursables 14 jours." */
    acceptTerms: z.literal(true),
    turnstileToken: z.string().min(1).max(2_048),
  })
  .strict();
export type CheckoutPackInput = z.infer<typeof checkoutPackSchema>;

export interface PackOffer {
  id: string;
  currency: PackCurrency;
  priceMinor: number;
  /** Credits received: paid part + bonus. */
  credits: number;
  bonus: number;
}

/** GET /api/wallet/packs: what the credits page shows. */
export interface PacksResponse {
  salesOpen: boolean;
  /** Payments configured on this deployment (the purchase link exists). */
  available: boolean;
  account: "personal" | "shop";
  packs: PackOffer[];
  wallet: WalletSummary;
  consentVersion: string;
}

/** POST /api/wallet/packs: the payment page to open (RevenueCat Web Purchase Link). */
export interface CheckoutPackResponse {
  url: string;
}

/** Version of the Pro subscription consent text (Subscription.consent in messages/*.json, draft for legal review). */
export const PLAN_CONSENT_VERSION = "2026-10";

export const checkoutPlanSchema = z
  .object({
    plan: z.enum(PAID_PLANS),
    interval: z.enum(PLAN_INTERVALS),
    /** "J'accepte les CGV et le renouvellement automatique, résiliable à tout moment pour la fin de la période." */
    acceptTerms: z.literal(true),
    /** Page language to come back to from Stripe. */
    locale: z.enum(LOCALES).default("fr"),
  })
  .strict();
export type CheckoutPlanInput = z.infer<typeof checkoutPlanSchema>;

/** Version of the Pass Boutique consent text (Subscription.pass.consent in messages/*.json). */
export const PASS_CONSENT_VERSION = "2026-10";
/** Lifecycle states of a shop that may buy a pass (an active one only on a pass of the same plan). */
export const PASS_BUYER_STATES: ReadonlySet<string> = new Set(["verified", "active", "downgraded"]);

export const checkoutPassSchema = z
  .object({
    pass: z.string().regex(/^[a-z0-9_]{1,40}$/),
    /** "J'accepte les CGV du Pass Boutique : paiement unique, sans renouvellement, sans remboursement au prorata." */
    acceptTerms: z.literal(true),
    /** The legal commitments of a temporary shop (src/lib/pro/commitments.ts, scope "pass"), ticked. */
    acceptCommitments: z.literal(true),
    locale: z.enum(LOCALES).default("fr"),
  })
  .strict();
export type CheckoutPassInput = z.infer<typeof checkoutPassSchema>;

export const billingPortalSchema = z.object({ locale: z.enum(LOCALES).default("fr") }).strict();

export interface PlanOffer {
  id: PaidPlanId;
  /** Price excluding tax per interval, MAD centimes. */
  priceMinor: { monthly: number; yearly: number };
  credits: number;
  featured: number;
  activeListings: number | null;
  /** Both Stripe Prices exist on this deployment. */
  available: boolean;
}

export interface PassOffer {
  id: string;
  plan: PaidPlanId;
  days: number;
  /** Price excluding tax, MAD centimes, paid once. */
  priceMinor: number;
  credits: number;
  activeListings: number | null;
  /** The Stripe Price exists on this deployment. */
  available: boolean;
  /** Bought now, the pass would end within `maxAheadDays` of today (else the checkout answers 409 pass_max_ahead). */
  withinLimit: boolean;
  /** The shop runs a pass of another plan (the checkout answers 409 pass_other_plan). */
  otherPlan: boolean;
}

export interface SubscriptionView {
  plan: PaidPlanId;
  interval: PlanInterval;
  status: "active" | "grace" | "billing_issue" | "cancelled" | "expired";
  periodEnd: string | null;
  willRenew: boolean;
}

/** GET /api/billing/subscription: the shop's plan page (owner only). */
export interface SubscriptionResponse {
  salesOpen: boolean;
  /** Stripe is configured on this deployment. */
  available: boolean;
  lifecycle: string;
  plan: string;
  planSource: "launch_offer" | "subscription" | "pass" | "none";
  /** End of the running Pass Boutique (planSource "pass"), else null. */
  passEndsAt: string | null;
  graceUntil: string | null;
  /** End of the launch offer, when set by an admin. */
  launchOfferEndsAt: string | null;
  /** Days of notice before the launch offer ends (`config/pricing.launchOffer.noticeDays`). */
  launchOfferNoticeDays: number;
  /** The shop is on the launch offer and it is still open (a pass cannot be bought then). */
  launchOfferOpen: boolean;
  subscription: SubscriptionView | null;
  plans: PlanOffer[];
  passes: PassOffer[];
  consentVersion: string;
  passConsentVersion: string;
}

/** POST /api/billing/checkout and /api/billing/portal: the Stripe page to open. */
export interface BillingRedirectResponse {
  url: string;
}

export interface InvoiceView {
  id: string;
  /** Stripe's invoice number, absent until finalized. */
  number: string | null;
  issuedAt: string;
  /** Amount with tax, minor units of `currency`. */
  totalMinor: number;
  currency: string;
  status: "open" | "paid" | "uncollectible" | "void";
  /** Stripe's hosted invoice page and PDF (Stripe hosts only). */
  hostedUrl: string | null;
  pdfUrl: string | null;
}

/** GET /api/billing/invoices: the shop's latest invoices, newest first (owner only). */
export interface InvoicesResponse {
  invoices: InvoiceView[];
}

export const PAYMENTS_API = {
  wallet: "/api/wallet",
  packs: "/api/wallet/packs",
  subscription: "/api/billing/subscription",
  checkout: "/api/billing/checkout",
  pass: "/api/billing/pass",
  portal: "/api/billing/portal",
  invoices: "/api/billing/invoices",
  options: (listingId: string) => `/api/listings/${listingId}/options`,
} as const;
