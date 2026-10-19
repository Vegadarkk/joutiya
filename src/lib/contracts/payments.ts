import { z } from "@/lib/zod";
import { OPTION_IDS, type OptionId } from "@/config/pricing";

// Credits wallet and paid listing options (phase 7 design §5). Client-safe contract shared by the
// promote dialog, the wallet page and the routes. Prices always come from the server: the body
// names the option, never an amount.

/** Version of the two purchase consent texts (Options.consent.* in messages/*.json, draft for legal review). */
export const OPTION_CONSENT_VERSION = "2026-10";

export const buyOptionSchema = z
  .object({
    optionId: z.enum(OPTION_IDS),
    /** Client-generated per attempt: a retried request debits once. */
    requestId: z.uuid(),
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
  options: OptionOffer[];
  wallet: WalletSummary;
  boosts: { bumpedAt: string | null; featuredUntil: string | null };
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

export const PAYMENTS_API = {
  wallet: "/api/wallet",
  options: (listingId: string) => `/api/listings/${listingId}/options`,
} as const;
