import "server-only";
import type { ShopSection } from "@/lib/contracts/catalog";
import { logger } from "@/lib/logging/logger";
import { toSearchCard } from "@/lib/search/cards";
import { searchEngine } from "@/lib/search/engine";
import type { SearchParams } from "@/lib/search/params";
import { buildFilter, sortSpecs } from "@/lib/search/service";
import type { SearchCard } from "@/lib/search/types";

// Counters of a real-estate agency's storefront (Agence pack design §3): the shop's listings per
// transaction (subcategory of a category), from one engine facet query. The storefront renders
// without them when the engine is down. And the shelves of a shop's storefront (catalogue §5).

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

/** Listings shown per storefront shelf (the total links to the shop's search for the rest). */
export const SHELF_LISTINGS = 12;

/** A tab of the storefront (catalogue §5): a section of the shop, or its running promotions. */
export interface StorefrontShelf {
  key: string;
  kind: "section" | "promo";
  /** The section's name; "" for the promotions. */
  name: string;
  total: number;
  listings: SearchCard[];
  /** The shop's search for this shelf (sections: `section`; promotions: `promo` and the discount sort). */
  params: SearchParams;
}

/**
 * The shop's sections that hold listings, then its promotions when some run: one multi-search,
 * newest first (the promotions by cut). Empty when the engine failed: the storefront keeps its
 * plain grid.
 */
export async function shopShelves(shopPublicId: string, sections: readonly ShopSection[], now = new Date()): Promise<StorefrontShelf[]> {
  const shelves: Omit<StorefrontShelf, "total" | "listings">[] = [
    ...sections.map((section) => ({ key: section.id, kind: "section" as const, name: section.name, params: { shop: shopPublicId, section: section.id } })),
    { key: "promotions", kind: "promo" as const, name: "", params: { shop: shopPublicId, promo: true as const, sort: "discount" as const } },
  ];
  try {
    const results = await searchEngine().search(
      shelves.map((shelf) => ({ q: "", filter: buildFilter(shelf.params, now), sort: sortSpecs(shelf.kind === "promo" ? "discount" : "recent", {}), page: 1, hitsPerPage: SHELF_LISTINGS })),
    );
    return shelves.flatMap((shelf, index) => {
      const result = results[index];
      if (!result || result.totalHits === 0) return [];
      return [{ ...shelf, total: result.totalHits, listings: result.hits.map((hit) => toSearchCard(hit, now)) }];
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "storefront shelves unavailable");
    return [];
  }
}
