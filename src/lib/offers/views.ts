import type { OfferEventView, OfferView } from "@/lib/contracts/offers";
import type { OfferDoc, OfferEventDoc } from "@/lib/db/schemas";
import { offerStatusAt } from "./rules";

// What a participant sees of the conversation's offer and of its system messages. A pending offer
// past its 48 h reads "expired" at once (the job offer-expiry writes it and its step later).

export function offerView(offer: OfferDoc, madeByMe: boolean, now: number): OfferView {
  return {
    id: offer.id,
    status: offerStatusAt({ status: offer.status, expiresAt: offer.expiresAt.getTime() }, now),
    madeByMe,
    amount: offer.amount,
    counter: offer.counter ?? null,
    price: offer.price,
    expiresAt: offer.expiresAt.getTime(),
    updatedAt: offer.updatedAt.getTime(),
  };
}

export function offerEventView(step: OfferEventDoc, byMe: boolean): OfferEventView {
  return { event: step.event, byMe, amount: step.amount };
}
