import "server-only";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { logger } from "@/lib/logging/logger";
import { searchEngine } from "./engine";
import { FLEET_FIELDS, toRentalFleet, type FleetDocument, type RentalFleetView } from "./rental-fleet-view";
import { buildFilter } from "./service";

// The fleet on a car rental agency's storefront (rental pack §5): the agency's searchable car
// rentals, cheapest first, from one engine query. Null when it rents nothing or the engine is
// down (the storefront renders without its fleet).

/** Vehicles the storefront grid holds; the count stays exact beyond it. */
export const STOREFRONT_FLEET_MAX = 100;

export async function rentalFleet(shopPublicId: string, now = new Date()): Promise<RentalFleetView | null> {
  const filter = buildFilter({ shop: shopPublicId, category: "vehicules", subcategory: RENTAL_SUBCATEGORY }, now);
  try {
    const [result] = await searchEngine().search([{ q: "", filter, sort: [{ field: "price", dir: "asc" }], page: 1, hitsPerPage: STOREFRONT_FLEET_MAX, fields: FLEET_FIELDS }]);
    if (!result || result.totalHits === 0) return null;
    return toRentalFleet(result.hits as unknown as FleetDocument[], result.totalHits, now);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "rental fleet unavailable");
    return null;
  }
}
