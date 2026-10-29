import type { PriceGuide } from "@/lib/price-guide/rules";

// « Prix repère » API (Carte vivante lot 5): public data only (statistics of published listings),
// cacheable. The map's detail panel (lot 3) reads it; the listing page renders the same guide on
// the server.

export type { PriceGuide, PriceGuideScope, PriceStats } from "@/lib/price-guide/rules";

/** GET -> 200 PriceGuideResponse (Cache-Control public), 404 for a listing that is not public, 429. */
export const priceGuidePath = (listingId: string) => `/api/listings/${listingId}/price-guide`;

export interface PriceGuideResponse {
  /** Null: no guide (donation, no price, excluded subcategory, fewer than 8 comparables). */
  guide: PriceGuide | null;
  /** The listing's own price (MAD) the guide was computed for: the marker on the scale. */
  price: number | null;
}
