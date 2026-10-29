import type { CriterionRow } from "@/lib/listings/criteria-rows";
import type { PriceGuideView } from "@/lib/price-guide/view";

// GET /api/listings/{id}/preview?locale=fr (src/lib/search/preview.ts): the map's detail panel
// fills its cards with it. Texts come localized; 404 when the listing is not online.

export interface ListingPreview {
  id: string;
  /** The start of the description (the panel shows a few lines). */
  description: string;
  /** Main criteria, condition first (the listing page's « Caractéristiques »). */
  criteria: CriterionRow[];
  guide: PriceGuideView | null;
  /** Null for an example listing. */
  seller: { type: "individual" | "pro"; publicId: string } | null;
}

export const listingPreviewPath = (id: string, locale: string) => `/api/listings/${encodeURIComponent(id)}/preview?locale=${encodeURIComponent(locale)}`;
