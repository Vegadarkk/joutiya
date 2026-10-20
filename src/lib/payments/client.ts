import { apiGet, apiPost } from "@/lib/auth/client";
import type { OptionId } from "@/config/pricing";
import { PAYMENTS_API, type BuyOptionResponse, type CheckoutPackResponse, type ListingOptionsResponse, type PacksResponse, type WalletResponse } from "@/lib/contracts/payments";

// Browser side of the credits wallet, the paid options and the credit packs (phase 7 design §5, §6).

export const loadListingOptions = (listingId: string) => apiGet<ListingOptionsResponse>(PAYMENTS_API.options(listingId));

/** `requestId` stays the same across retries of one purchase: the server debits it once. */
export const buyListingOption = (listingId: string, optionId: OptionId, requestId: string, expectedCost: number) =>
  apiPost<BuyOptionResponse>(PAYMENTS_API.options(listingId), { optionId, requestId, expectedCost, acceptTerms: true, immediateExecutionConsent: true });

export const loadWallet = (after?: string) => apiGet<WalletResponse>(after ? `${PAYMENTS_API.wallet}?after=${encodeURIComponent(after)}` : PAYMENTS_API.wallet);

export const loadPacks = () => apiGet<PacksResponse>(PAYMENTS_API.packs);

/** Answers the payment page to open; the price is the one shown (a changed price is refused). */
export const checkoutPack = (packId: string, expectedPriceMinor: number, turnstileToken: string) =>
  apiPost<CheckoutPackResponse>(PAYMENTS_API.packs, { packId, expectedPriceMinor, acceptTerms: true, turnstileToken });
