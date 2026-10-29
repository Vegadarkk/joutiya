import "server-only";
import { VEHICLE_SALE_SUBCATEGORIES } from "@/config/categories";
import { logger } from "@/lib/logging/logger";
import { searchEngine } from "./engine";
import { attributeField, type EngineQuery, type EngineResult, type FilterExpr } from "./types";

// The car stock of a Pro shop (Concession pack, design concession/concession.md §5), for its
// storefront: counts by vehicle type, brand, fuel and gearbox, the services its listings declare
// (trade-in, financing, warranty) and the price range, from the search index in one round trip
// (a facet query and the cheapest and dearest listing). Derived from the published listings only:
// no shop setting to keep up to date. Null when the shop sells no vehicle or the index is down.

export interface Count {
  value: string;
  count: number;
}

export interface DealerStock {
  total: number;
  subcategories: Count[];
  /** Car and van brands (`car-brand`) then motorbike brands (`moto-brand`), most listed first. */
  brands: (Count & { criterion: "car-brand" | "moto-brand" })[];
  fuels: Count[];
  gearboxes: Count[];
  /** Listings declaring each service. */
  services: { tradeIn: number; financing: number; warranty: number };
  /** MAD; null when no listing carries a price. */
  price: { min: number; max: number } | null;
}

/** Brands shown before "see all". */
export const DEALER_BRANDS_MAX = 8;

const FACETS = {
  subcategory: "subcategoryId",
  carBrand: attributeField("car-brand"),
  motoBrand: attributeField("moto-brand"),
  fuel: attributeField("fuel"),
  gearbox: attributeField("gearbox"),
  tradeIn: attributeField("trade-in"),
  financing: attributeField("financing"),
  warranty: attributeField("vehicle-warranty"),
} as const;

function counts(distribution: Record<string, number> | undefined): Count[] {
  return Object.entries(distribution ?? {})
    .filter(([, count]) => count > 0)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const countOf = (distribution: Record<string, number> | undefined, ...values: string[]) => values.reduce((sum, value) => sum + (distribution?.[value] ?? 0), 0);

/** The stock summary of a facet result and the two price probes (pure, unit-tested). */
export function toDealerStock(facets: EngineResult, cheapest: EngineResult, dearest: EngineResult): DealerStock | null {
  if (facets.totalHits === 0) return null;
  const distribution = facets.facetDistribution ?? {};
  const min = cheapest.hits[0]?.price;
  const max = dearest.hits[0]?.price;
  return {
    total: facets.totalHits,
    subcategories: counts(distribution[FACETS.subcategory]),
    brands: [
      ...counts(distribution[FACETS.carBrand]).map((count) => ({ ...count, criterion: "car-brand" as const })),
      ...counts(distribution[FACETS.motoBrand]).map((count) => ({ ...count, criterion: "moto-brand" as const })),
    ].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    fuels: counts(distribution[FACETS.fuel]),
    gearboxes: counts(distribution[FACETS.gearbox]),
    services: {
      tradeIn: countOf(distribution[FACETS.tradeIn], "true"),
      financing: countOf(distribution[FACETS.financing], "true"),
      warranty: countOf(distribution[FACETS.warranty], "constructeur", "vendeur"),
    },
    price: typeof min === "number" && typeof max === "number" ? { min, max } : null,
  };
}

export async function dealerStock(sellerPublicId: string): Promise<DealerStock | null> {
  const filter: FilterExpr = {
    and: [
      { field: "sellerPublicId", op: "eq", value: sellerPublicId },
      { field: "subcategoryId", op: "in", values: [...VEHICLE_SALE_SUBCATEGORIES] },
    ],
  };
  const priced: FilterExpr = { and: [filter, { field: "price", op: "exists" }] };
  const queries: EngineQuery[] = [
    { q: "", filter, page: 1, hitsPerPage: 0, facets: Object.values(FACETS) },
    { q: "", filter: priced, sort: [{ field: "price", dir: "asc" }], page: 1, hitsPerPage: 1, fields: ["id", "price"] },
    { q: "", filter: priced, sort: [{ field: "price", dir: "desc" }], page: 1, hitsPerPage: 1, fields: ["id", "price"] },
  ];
  try {
    const [facets, cheapest, dearest] = await searchEngine().search(queries);
    return facets && cheapest && dearest ? toDealerStock(facets, cheapest, dearest) : null;
  } catch (error) {
    // The storefront renders without its stock summary rather than failing.
    logger.warn({ err: (error as Error).message }, "dealer stock unavailable");
    return null;
  }
}
