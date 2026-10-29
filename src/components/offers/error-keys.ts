import { ApiError } from "@/lib/auth/client";

// Refusal codes of an offer step with their own wording (Carte vivante lot 5). Apart from the hook
// (errors.ts) so that the listing page's message dialog does not pull the messaging's messages.

export const OFFER_ERROR_KEYS = ["offer_changed", "offer_expired", "offer_pending", "offer_unavailable"] as const;
export type OfferErrorKey = (typeof OFFER_ERROR_KEYS)[number];

export function offerErrorKey(error: unknown): OfferErrorKey | null {
  const code = error instanceof ApiError ? error.code : null;
  return OFFER_ERROR_KEYS.find((key) => key === code) ?? null;
}
