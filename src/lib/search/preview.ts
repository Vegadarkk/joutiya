import "server-only";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/config/site";
import type { ListingPreview } from "@/lib/contracts/listing-preview";
import { criteriaRows, type CriteriaTranslators } from "@/lib/listings/criteria-rows";
import { priceGuideFor } from "@/lib/price-guide/service";
import { priceGuideView, type PriceGuideTranslator } from "@/lib/price-guide/view";
import { truncateText } from "./document";
import { searchEngine } from "./engine";
import type { SearchDocument, SearchEngine } from "./types";

// Preview of a listing for the map's detail panel (Carte vivante): its main criteria, the start of
// its description, its « Prix repère » and its seller type, read from the search index only (the
// index holds published, visible listings: no Firestore read, and a withdrawn listing is gone from
// it). The guide shares the listing page's 24 h cache (priceGuideFor, same subject). A document
// indexed before the `attributes` field existed (until the next reindex) shows no criteria nor
// guide: computing one from partial criteria would overwrite the page's cached guide.

/** Characters of the description sent (the panel shows a few lines). */
export const PREVIEW_DESCRIPTION_MAX = 600;

const FIELDS = ["id", "subcategoryId", "description", "attributes", "condition", "price", "isDonation", "citySlug", "regionCode", "sellerType", "sellerPublicId", "isExample"] as const satisfies readonly (keyof SearchDocument)[];
type PreviewDocument = Partial<Pick<SearchDocument, (typeof FIELDS)[number]>>;

/** The preview of a listing in `locale`, or null when the index does not hold it. */
export async function listingPreview(id: string, locale: Locale, engine: SearchEngine = searchEngine()): Promise<ListingPreview | null> {
  const [result] = await engine.search([{ q: "", filter: { field: "id", op: "eq", value: id }, page: 1, hitsPerPage: 1, fields: FIELDS }]);
  const doc = result?.hits[0] as PreviewDocument | undefined;
  if (!doc || doc.id !== id || !doc.subcategoryId) return null;
  const example = doc.isExample === true;
  const { subcategoryId, attributes, price } = doc;
  const priced = !example && typeof price === "number" && price > 0 && !doc.isDonation;
  const [criteria, page, guideT, guide] = await Promise.all([
    getTranslations({ locale, namespace: "Criteria" }),
    getTranslations({ locale, namespace: "ListingPage.criteria" }),
    getTranslations({ locale, namespace: "PriceGuide" }),
    priced && attributes && doc.citySlug && doc.regionCode
      ? priceGuideFor({ id, subcategoryId, attributes, price, isDonation: false, citySlug: doc.citySlug, regionCode: doc.regionCode }, engine)
      : Promise.resolve(null),
  ]);
  return {
    id,
    description: truncateText(doc.description ?? "", PREVIEW_DESCRIPTION_MAX),
    criteria: attributes || doc.condition ? criteriaRows({ subcategoryId, attributes: attributes ?? {}, condition: doc.condition ?? null }, { criteria, page } as unknown as CriteriaTranslators) : [],
    guide: guide && priced ? priceGuideView(guide, price, locale, guideT as unknown as PriceGuideTranslator) : null,
    // An example listing (src/lib/demo) has no seller to show.
    seller: example || !doc.sellerPublicId || !doc.sellerType ? null : { type: doc.sellerType, publicId: doc.sellerPublicId },
  };
}
