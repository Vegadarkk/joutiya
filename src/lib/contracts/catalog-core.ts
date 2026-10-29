// Stock and combination keys of a Pro listing (lot 4, catalogue §2-3), without the schemas: the
// listing page's variant picker bundles this module, never zod (catalog.ts re-exports it).

/** « Plus que N en stock » from this level down (0 reads « Épuisé »). */
export const LOW_STOCK = 5;

/** Joins the values of a combination, axis order (`"m|bleu"`); values never hold it. */
export const VARIANT_KEY_SEPARATOR = "|";

export function variantKey(values: readonly string[]): string {
  return values.join(VARIANT_KEY_SEPARATOR);
}

/** What the stock of a listing or combination shows. */
export type StockState = "untracked" | "in_stock" | "low" | "sold_out";

export function stockState(stock: number | undefined | null): StockState {
  if (stock === undefined || stock === null) return "untracked";
  if (stock <= 0) return "sold_out";
  return stock <= LOW_STOCK ? "low" : "in_stock";
}

interface StockItem {
  key?: string;
  stock?: number | undefined;
}

/** Stock 0 everywhere it is tracked, and tracked everywhere: sold out (decision 1, still online). */
export function isSoldOut(listing: { stock?: number | undefined; variants?: { items: readonly StockItem[] } | undefined }): boolean {
  if (listing.variants) return listing.variants.items.every((item) => item.stock === 0);
  return listing.stock === 0;
}

/** Combination still sold: stock not tracked, or above 0. */
export const itemAvailable = (item: StockItem) => item.stock === undefined || item.stock > 0;
