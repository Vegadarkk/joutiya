import "server-only";
import { isSoldOut, priceRange } from "@/lib/contracts/catalog";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { HttpError } from "@/lib/http/errors";
import { acceptsContact } from "@/lib/listings/public";
import { offerAllowed } from "./eligibility";
import { offerReferencePrice } from "./rules";

// Whether a stored listing takes price offers, and at which price (Carte vivante lot 5): read by
// the offer steps and by the messaging when a conversation starts (its listing snapshot).

/** The price offers on `listing` are measured against at `now`, or null when it takes no offer. */
export function listingOfferPrice(listing: ListingRecord | null, now: Date): number | null {
  if (!listing || !listing.subcategoryId || listing.status !== "published" || listing.moderation.hiddenBy || !acceptsContact(listing)) return null;
  const range = priceRange(listing);
  const promo = listing.promo ? { startsAt: listing.promo.startsAt.getTime(), endsAt: listing.promo.endsAt.getTime(), prices: listing.promo.prices } : null;
  const price = offerReferencePrice({ price: listing.price, promo }, now.getTime());
  const allowed = offerAllowed({
    subcategoryId: listing.subcategoryId,
    price,
    isDonation: listing.isDonation,
    example: listing.example === true,
    soldOut: isSoldOut(listing),
    severalPrices: range !== null && range.max > range.min,
  });
  return allowed ? price : null;
}

/** The listing an offer is about: one that takes offers, else 409 offer_unavailable. Returns its offer price. */
export function assertOfferListing(listing: ListingRecord | null, now: Date): number {
  const price = listingOfferPrice(listing, now);
  if (price === null) throw new HttpError(409, "offer_unavailable");
  return price;
}
