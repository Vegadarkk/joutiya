import { subcategoryById } from "@/config/categories";

// Which listings take price offers (Carte vivante lot 5). Pure; apart from rules.ts so that the
// client islands that only need the bounds do not load the category tree.

export interface OfferListing {
  subcategoryId: string;
  /** The price offers are measured against (DH); null: "à discuter". */
  price: number | null;
  isDonation: boolean;
  example?: boolean;
  soldOut?: boolean;
  /** Pro catalogue combinations at different prices: no single price to offer on. */
  severalPrices?: boolean;
}

/** Categories whose amount is not a price to bargain on: services, job ads (a salary). */
const NO_OFFER_CATEGORIES: ReadonlySet<string> = new Set(["services", "emploi"]);

/**
 * A listing takes offers: a price, not a donation, not an example, not sold out, one price, and a
 * subcategory of goods (no services, no job ad, no rental: a price per day, month or night).
 */
export function offerAllowed(listing: OfferListing): boolean {
  if (listing.isDonation || listing.example || listing.soldOut || listing.severalPrices) return false;
  if (listing.price === null || listing.price <= 0) return false;
  const subcategory = subcategoryById(listing.subcategoryId);
  if (!subcategory || NO_OFFER_CATEGORIES.has(subcategory.categoryId) || subcategory.priceUnit) return false;
  return true;
}
