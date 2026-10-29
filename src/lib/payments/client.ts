import { apiGet, apiPost } from "@/lib/auth/client";
import type { OptionId, PaidPlanId, PlanInterval } from "@/config/pricing";
import type { Locale } from "@/config/site";
import {
  PAYMENTS_API,
  type BillingRedirectResponse,
  type BuyOptionResponse,
  type CheckoutPackResponse,
  type InvoicesResponse,
  type ListingOptionsResponse,
  type PacksResponse,
  type SubscriptionResponse,
  type WalletResponse,
} from "@/lib/contracts/payments";

// Browser side of the credits wallet, the paid options, the credit packs and the Pro plans
// (phase 7 design §5, §6, §7).

export const loadListingOptions = (listingId: string) => apiGet<ListingOptionsResponse>(PAYMENTS_API.options(listingId));

/** `requestId` stays the same across retries of one purchase: the server debits it once. */
export const buyListingOption = (listingId: string, optionId: OptionId, requestId: string, expectedCost: number) =>
  apiPost<BuyOptionResponse>(PAYMENTS_API.options(listingId), { optionId, requestId, expectedCost, acceptTerms: true, immediateExecutionConsent: true });

export const loadWallet = (after?: string) => apiGet<WalletResponse>(after ? `${PAYMENTS_API.wallet}?after=${encodeURIComponent(after)}` : PAYMENTS_API.wallet);

export const loadPacks = () => apiGet<PacksResponse>(PAYMENTS_API.packs);

/** Answers the payment page to open; the price is the one shown (a changed price is refused). */
export const checkoutPack = (packId: string, expectedPriceMinor: number, turnstileToken: string) =>
  apiPost<CheckoutPackResponse>(PAYMENTS_API.packs, { packId, expectedPriceMinor, acceptTerms: true, turnstileToken });

export const loadSubscription = () => apiGet<SubscriptionResponse>(PAYMENTS_API.subscription);

/** Answers Stripe's Checkout page of the plan; `locale` is the page to come back to. */
export const checkoutPlan = (plan: PaidPlanId, interval: PlanInterval, locale: Locale) => apiPost<BillingRedirectResponse>(PAYMENTS_API.checkout, { plan, interval, acceptTerms: true, locale });

export const checkoutPass = (pass: string, locale: Locale) => apiPost<BillingRedirectResponse>(PAYMENTS_API.pass, { pass, acceptTerms: true, acceptCommitments: true, locale });

export const openBillingPortal = (locale: Locale) => apiPost<BillingRedirectResponse>(PAYMENTS_API.portal, { locale });

export const loadInvoices = () => apiGet<InvoicesResponse>(PAYMENTS_API.invoices);
