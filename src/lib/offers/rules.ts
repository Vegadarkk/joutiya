// Price offers in a conversation (Carte vivante lot 5), rules shared by the listing page's islands,
// the thread and the server. Pure and zod-free: contracts/offers.ts re-exports them with the
// schemas. The buyer proposes a whole amount in DH, between 30 % of the listing's price and the
// price; the seller accepts, declines or counters once (same bounds, above the offer); the buyer
// withdraws or accepts the counter. An offer waits 48 h at most. An accepted offer is not a sale
// nor a payment: the platform is a neutral host and takes no part in it.

export const OFFER_STATUSES = ["open", "countered", "accepted", "declined", "withdrawn", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** What a system message of the thread says about the offer. */
export const OFFER_EVENTS = ["made", "countered", "accepted", "declined", "withdrawn", "expired"] as const;
export type OfferEvent = (typeof OFFER_EVENTS)[number];

/** An offer, then a counter-offer, waits this long for an answer. */
export const OFFER_TTL_MS = 48 * 60 * 60 * 1000;
/** Lowest offer: this share of the listing's price (rounded up), against lowball spam. */
export const OFFER_MIN_SHARE = 0.3;
/** Optional note with an offer, sent as an ordinary message (screened like every message). */
export const OFFER_NOTE_MAX = 300;

/** Stored text of an offer system message: the UI renders it localized (inbox preview too). */
export const offerMarker = (event: OfferEvent) => `⟦offre:${event}⟧`;
const MARKER = /^⟦offre:([a-z_]+)⟧$/;

/** The event of an offer marker text, else null. */
export function offerEventOf(text: string): OfferEvent | null {
  const event = MARKER.exec(text)?.[1];
  return (OFFER_EVENTS as readonly string[]).includes(event ?? "") ? (event as OfferEvent) : null;
}

/** Inclusive bounds of an offer (or a counter-offer) on a listing priced `price` DH. */
export function offerBounds(price: number): { min: number; max: number } {
  return { min: Math.max(1, Math.ceil(price * OFFER_MIN_SHARE)), max: price };
}

export type OfferProblem = "not_whole" | "too_low" | "too_high" | "not_above_offer";

/** Why `amount` cannot be offered on a listing priced `price` (and above `above`, a counter), else null. */
export function offerProblem(amount: number, price: number, above?: number): OfferProblem | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return "not_whole";
  const bounds = offerBounds(price);
  if (amount < bounds.min) return "too_low";
  if (amount > bounds.max) return "too_high";
  if (above !== undefined && amount <= above) return "not_above_offer";
  return null;
}

/** Waiting for an answer: open (the seller answers) or countered (the buyer answers), not past its 48 h. */
export function offerPending(offer: { status: OfferStatus; expiresAt: number }, now: number): boolean {
  return (offer.status === "open" || offer.status === "countered") && offer.expiresAt > now;
}

/** The status a reader sees: a pending offer past its 48 h reads "expired" before the sweep writes it. */
export function offerStatusAt(offer: { status: OfferStatus; expiresAt: number }, now: number): OfferStatus {
  return (offer.status === "open" || offer.status === "countered") && offer.expiresAt <= now ? "expired" : offer.status;
}

/** The amount agreed on: the counter-offer when the buyer accepted it, else the offer. */
export const offerFinalAmount = (offer: { amount: number; counter?: number | null }): number => offer.counter ?? offer.amount;

/**
 * The price an offer is measured against: the listing's price, or the promotional price while a
 * promotion runs (a Pro's listing; the lowest of its prices). Null: no price.
 */
export function offerReferencePrice(input: { price: number | null; promo?: { startsAt: number; endsAt: number; prices: readonly { price: number }[] } | null }, now: number): number | null {
  if (input.price === null) return null;
  const promo = input.promo;
  if (promo && promo.startsAt <= now && now < promo.endsAt && promo.prices.length > 0) return Math.min(input.price, ...promo.prices.map((entry) => entry.price));
  return input.price;
}
