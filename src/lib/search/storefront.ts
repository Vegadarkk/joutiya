import "server-only";
import { searchEngine } from "@/lib/search/engine";
import { buildFilter } from "@/lib/search/service";
import { logger } from "@/lib/logging/logger";

// Counters of a real-estate agency's storefront (Agence pack design §3): the shop's listings per
// transaction (subcategory of a category), from one engine facet query. The storefront renders
// without them when the engine is down.

/** Subcategory -> the shop's searchable listings in `category`, or null when the engine failed. */
export async function shopSubcategoryCounts(shopPublicId: string, category: string, now = new Date()): Promise<Record<string, number> | null> {
  try {
    const [result] = await searchEngine().search([{ q: "", filter: buildFilter({ shop: shopPublicId, category }, now), page: 1, hitsPerPage: 1, facets: ["subcategoryId"], fields: ["id"] }]);
    const distribution = result?.facetDistribution?.subcategoryId ?? {};
    return Object.fromEntries(Object.entries(distribution).filter(([, count]) => count > 0));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "storefront counts unavailable");
    return null;
  }
}
