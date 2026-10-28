import { cardFactsField, cardFactsOf } from "@/lib/listings/card-facts";
import { attributeField, type CardDocument, type SearchCard } from "./types";

// Engine hit -> results card (design D22): the one card shape of every engine-backed list (search,
// /c pages, home, favorites). Whitelists the fields, so nothing the index adds later leaks to clients.

/**
 * `featured` marks a card served in an À la Une slot; the "Sponsorisé" mention needs a boost still
 * running at `now` (an expiry not yet swept from the index never shows it).
 */
export function toSearchCard(doc: CardDocument, now: Date, featured = false): SearchCard {
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
  };
}
