import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { cardFactsField, cardFactsOf } from "@/lib/listings/card-facts";
import { rentalDayRate } from "@/lib/listings/rental";
import { rentalDuration, type RentalDates } from "./params";
import { attributeField, type CardDocument, type SearchCard } from "./types";

/** A car rental searched by dates: its estimated total (long-term rate applied) and freshness. */
function rentalOf(doc: CardDocument, now: Date, dates: RentalDates): NonNullable<SearchCard["rental"]> {
  const days = rentalDuration(dates);
  const attributes: Record<string, number> = {};
  if (typeof doc.a_rate_7_days === "number") attributes["rate-7-days"] = doc.a_rate_7_days;
  if (typeof doc.a_rate_30_days === "number") attributes["rate-30-days"] = doc.a_rate_30_days;
  const total = typeof doc.price === "number" ? rentalDayRate(attributes, doc.price, days) * days : null;
  return { days, total, fresh: typeof doc.rentFreshUntil === "number" && doc.rentFreshUntil > now.getTime(), from: dates.from, to: dates.to };
}

// Engine hit -> results card (design D22): the one card shape of every engine-backed list (search,
// /c pages, home, favorites). Whitelists the fields, so nothing the index adds later leaks to clients.

/**
 * `featured` marks a card served in an À la Une slot; the "Sponsorisé" mention needs a boost still
 * running at `now` (an expiry not yet swept from the index never shows it). `dates`: a car rental
 * search by dates, whose cards carry the estimated total and the freshness.
 */
export function toSearchCard(doc: CardDocument, now: Date, featured = false, dates?: RentalDates): SearchCard {
  const photo = doc.photo ? { id: doc.photo.id, w: doc.photo.w, h: doc.photo.h, blurhash: doc.photo.blurhash } : null;
  return {
    id: doc.id,
    slugId: doc.slugId,
    title: doc.title,
    subcategoryId: doc.subcategoryId || null,
    price: typeof doc.price === "number" ? doc.price : null,
    priceNegotiable: doc.priceNegotiable === true,
    isDonation: doc.isDonation === true,
    citySlug: doc.citySlug || null,
    photo,
    photoCount: Number.isInteger(doc.photoCount) ? doc.photoCount : photo ? 1 : 0,
    sellerType: doc.sellerType === "pro" ? "pro" : "individual",
    sortAt: new Date(Number.isFinite(doc.sortAt) ? doc.sortAt : now.getTime()).toISOString(),
    bumped: doc.isBumped === true,
    featured: featured && typeof doc.featuredUntil === "number" && doc.featuredUntil > now.getTime(),
    ...cardFactsField(cardFactsOf(doc.subcategoryId, (id) => (doc as Record<string, unknown>)[attributeField(id)])),
    ...(doc.isExample === true ? { example: true as const } : {}),
    ...(doc.soldOut === true ? { soldOut: true as const } : {}),
    ...(doc.priceFrom === true ? { priceFrom: true as const } : {}),
    ...(dates && doc.subcategoryId === RENTAL_SUBCATEGORY ? { rental: rentalOf(doc, now, dates) } : {}),
  };
}
