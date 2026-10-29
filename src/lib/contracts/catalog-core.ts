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

// ---- Promotions (catalogue §4, law 31-08 art. 53-55)

export const PROMO_KINDS = ["promo", "soldes", "flash"] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

/** A promotion's price for one key ("" for the listing, else a combination) and its struck-out price. */
export interface PromoPrice {
  key: string;
  price: number;
  /** Lowest price of the 30 days before the start (art. 54); null when the listing is younger (no struck-out price). */
  reference: number | null;
}

/** A promotion as stored and shown (dates as epoch ms on the client views). */
export interface PromoView {
  kind: PromoKind;
  startsAt: number;
  endsAt: number;
  prices: PromoPrice[];
}

/** Running at `now`: started and not ended (an ended one is ignored by every reader, nothing is rewritten in a hurry). */
export function promoRunning(promo: Pick<PromoView, "startsAt" | "endsAt"> | null | undefined, now: number): boolean {
  return promo !== null && promo !== undefined && promo.startsAt <= now && now < promo.endsAt;
}

/** Whole percent off `before` (« -20 % »), floored so it never overstates the cut. */
export function percentOff(price: number, before: number): number {
  return before > 0 && price < before ? Math.floor(((before - price) / before) * 100) : 0;
}

/** The lowest promotional price, its struck-out price and the largest cut, for a card. */
export function promoSummary(promo: Pick<PromoView, "prices">): { price: number; reference: number | null; percent: number } | null {
  if (promo.prices.length === 0) return null;
  const lowest = promo.prices.reduce((best, entry) => (entry.price < best.price ? entry : best));
  const percent = Math.max(0, ...promo.prices.map((entry) => (entry.reference === null ? 0 : percentOff(entry.price, entry.reference))));
  return { price: lowest.price, reference: lowest.reference, percent };
}

/** What a card shows of a running promotion: the badge, the lowest price and its struck-out price. */
export interface CardPromo {
  kind: PromoKind;
  price: number;
  /** Null: no struck-out price (listing younger than 30 days). */
  reference: number | null;
  /** Largest cut against a struck-out price (« -20 % »); 0 without one. */
  percent: number;
  /** Epoch ms (a flash sale's countdown). */
  endsAt: number;
}

export function cardPromo(promo: PromoView | null | undefined, now: number): CardPromo | null {
  if (!promo || !promoRunning(promo, now)) return null;
  const summary = promoSummary(promo);
  return summary ? { kind: promo.kind, ...summary, endsAt: promo.endsAt } : null;
}
