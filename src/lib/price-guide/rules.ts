import { criterionById, subcategoryById } from "@/config/categories";
import { roundingStep } from "./rounding";

export { roundingStep };

// « Prix repère » (Carte vivante lot 5): a typical price range for a listing, computed from the
// comparable published listings (same subcategory and the criteria that drive the price), widening
// the area from the city to the region, then Morocco, until enough are found. Pure and zod-free:
// the server (service.ts), the listing page and the tests share it. Joutiya is a neutral host: the
// guide gives a position, never a verdict ("bon prix", "trop cher"), and no single seller makes it:
// each seller counts for PRICE_GUIDE_MAX_PER_SELLER prices at most, and a guide needs
// PRICE_GUIDE_MIN_SELLERS distinct sellers (a dealer's stock or sock-puppet listings cannot set the
// "fourchette habituelle" their own listing is then placed in).

/** Fewer comparables than this (after the per-seller cap): no guide. */
export const PRICE_GUIDE_MIN_COMPARABLES = 8;
/** Fewer distinct sellers than this among the comparables: no guide. */
export const PRICE_GUIDE_MIN_SELLERS = 5;
/**
 * Prices kept per seller at most (their most recent listings). Two, not one: a seller often has two
 * comparable listings, and with 8 comparables from 5 sellers one seller weighs 25 % at most.
 */
export const PRICE_GUIDE_MAX_PER_SELLER = 2;
/** Prices read per area at most (the most recent first). */
export const PRICE_GUIDE_MAX_PRICES = 200;
/** Share of the lowest and of the highest prices dropped as outliers (one on each side at least). */
export const PRICE_GUIDE_TRIM = 0.1;
/** A computed guide (or its absence) is kept this long (Valkey). */
export const PRICE_GUIDE_TTL_SECONDS = 24 * 60 * 60;

export const PRICE_GUIDE_SCOPES = ["city", "region", "country"] as const;
export type PriceGuideScope = (typeof PRICE_GUIDE_SCOPES)[number];

/**
 * Categories and subcategories without a guide: services (a quote, not a price), producers' food
 * (sold by weight or volume), wholesale lots and livestock (prices per lot), the catch-all
 * subcategory, holiday rentals (per night) and adults-only goods.
 */
const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(["services", "terroir", "emploi"]);
const EXCLUDED_SUBCATEGORIES: ReadonlySet<string> = new Set(["autres", "stocks-gros", "betail-moutons"]);

/** How a criterion narrows the comparables. */
export type GuideKey =
  /** Same option (select) or same number. */
  | { id: string; kind: "eq" }
  /** A number within `ratio` (share of the value) or `abs` (units) on each side. */
  | { id: string; kind: "band"; ratio?: number; abs?: number }
  /** Free text (a model): every word must be found in the listing's text. */
  | { id: string; kind: "text" };

const eq = (id: string): GuideKey => ({ id, kind: "eq" });
const text = (id: string): GuideKey => ({ id, kind: "text" });
const years = (abs: number): GuideKey => ({ id: "year", kind: "band", abs });
const surface: GuideKey = { id: "surface", kind: "band", ratio: 0.2 };

/**
 * The criteria that drive the price, by subcategory. Others: their required option criteria
 * (a phone's brand, a garment's type and size...). A criterion the listing leaves empty is skipped.
 */
const KEYS: Readonly<Record<string, readonly GuideKey[]>> = {
  voitures: [eq("car-brand"), text("model"), years(1)],
  "utilitaires-camions": [eq("utility-type"), eq("car-brand"), years(2)],
  "motos-scooters": [eq("moto-brand"), eq("engine-size"), years(2)],
  "location-voitures": [eq("rental-class"), eq("car-brand")],
  bateaux: [eq("boat-type"), years(5)],
  vente: [eq("property-type"), eq("rooms"), surface],
  location: [eq("property-type"), eq("rooms"), surface],
  colocation: [eq("room-type")],
  "telephones-objets-connectes": [eq("phone-device-type"), eq("phone-brand"), text("model"), eq("storage")],
  ordinateurs: [eq("computer-type"), eq("computer-brand"), text("model"), eq("ram")],
  tablettes: [eq("tablet-brand"), text("model"), eq("storage")],
  "consoles-jeux-video": [eq("gaming-type"), eq("platform")],
};

/** Words of a text key kept for the engine query (a model name). */
const TEXT_WORDS_MAX = 3;
const TEXT_LENGTH_MAX = 40;

/** Whether listings of `subcategoryId` may get a guide at all. */
export function priceGuideApplies(subcategoryId: string): boolean {
  const subcategory = subcategoryById(subcategoryId);
  if (!subcategory) return false;
  if (EXCLUDED_CATEGORIES.has(subcategory.categoryId) || EXCLUDED_SUBCATEGORIES.has(subcategory.id)) return false;
  if (subcategory.adultsOnly || subcategory.priceUnit === "night") return false;
  return true;
}

/** The keys of a subcategory: its own list, else its required option criteria (main group only). */
export function guideKeys(subcategoryId: string): readonly GuideKey[] {
  const own = KEYS[subcategoryId];
  if (own) return own;
  const subcategory = subcategoryById(subcategoryId);
  return (subcategory?.criteria ?? []).filter((criterion) => criterion.required && !criterion.group && !criterion.proOnly && criterion.type === "select").map((criterion) => eq(criterion.id));
}

/** What the comparables share with the listing (engine filters are built from it, server side). */
export interface ComparableSpec {
  subcategoryId: string;
  /** Criterion id -> the listing's option or number. */
  equals: Record<string, string | number>;
  /** Criterion id -> inclusive bounds. */
  ranges: Record<string, { min: number; max: number }>;
  /** Words every comparable must contain ("" = none). */
  text: string;
}

export interface GuideListing {
  subcategoryId: string;
  attributes: Readonly<Record<string, unknown>>;
  price: number | null;
  isDonation: boolean;
  example?: boolean;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const words = value
    .replace(/[\u0000-\u001f\u007f"“”«»⟦⟧]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TEXT_WORDS_MAX);
  const joined = words.join(" ").slice(0, TEXT_LENGTH_MAX).trim();
  return joined || null;
}

/**
 * The comparables of a listing, or null when it gets no guide: a donation, no price, an example,
 * an excluded subcategory, or a key criterion set to "autre" (nothing to compare with).
 */
export function comparableSpec(listing: GuideListing): ComparableSpec | null {
  if (listing.isDonation || listing.example || listing.price === null || listing.price <= 0) return null;
  if (!priceGuideApplies(listing.subcategoryId)) return null;
  const spec: ComparableSpec = { subcategoryId: listing.subcategoryId, equals: {}, ranges: {}, text: "" };
  const words: string[] = [];
  for (const key of guideKeys(listing.subcategoryId)) {
    const value = listing.attributes[key.id];
    if (value === undefined || value === null || value === "") continue;
    const criterion = criterionById(key.id);
    if (!criterion) continue;
    if (key.kind === "text") {
      const found = textValue(value);
      if (found) words.push(found);
      continue;
    }
    if (key.kind === "eq") {
      if (value === "autre") return null;
      if (criterion.type === "select" && typeof value === "string") spec.equals[key.id] = value;
      else if (criterion.type === "number" && typeof value === "number" && Number.isFinite(value)) spec.equals[key.id] = value;
      continue;
    }
    if (criterion.type !== "number" || typeof value !== "number" || !Number.isFinite(value)) continue;
    const spread = key.abs ?? Math.max(1, Math.round(value * (key.ratio ?? 0)));
    spec.ranges[key.id] = { min: value - spread, max: value + spread };
  }
  spec.text = words.join(" ");
  return spec;
}

/** Stable text of a spec: the cache tells a listing whose criteria changed. */
export function specKey(spec: ComparableSpec): string {
  const equals = Object.entries(spec.equals).sort(([a], [b]) => (a < b ? -1 : 1));
  const ranges = Object.entries(spec.ranges).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify([spec.subcategoryId, equals, ranges, spec.text.toLowerCase()]);
}

/** Percentile `p` (0-1) of sorted `values`, linear between neighbours. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * p;
  const below = Math.floor(at);
  const above = Math.ceil(at);
  const low = sorted[below] ?? 0;
  const high = sorted[above] ?? low;
  return low + (high - low) * (at - below);
}

export interface PriceStats {
  /** Lowest and highest kept prices (outliers dropped), rounded outwards. */
  low: number;
  high: number;
  /** First and third quartiles of the kept prices, rounded outwards: the typical range. */
  p25: number;
  p75: number;
  /** Comparable listings read (before the outliers were dropped). */
  count: number;
}

/** The range of `prices`, or null below PRICE_GUIDE_MIN_COMPARABLES. */
export function priceStats(prices: readonly number[]): PriceStats | null {
  const sorted = prices.filter((price) => Number.isFinite(price) && price > 0).sort((a, b) => a - b);
  if (sorted.length < PRICE_GUIDE_MIN_COMPARABLES) return null;
  // At least one price off each end: below 10 comparables 10 % rounds to none, and the scale would
  // end on single listings.
  const cut = Math.max(1, Math.floor(sorted.length * PRICE_GUIDE_TRIM));
  const kept = sorted.slice(cut, sorted.length - cut);
  const step = roundingStep(percentile(kept, 0.75));
  const down = (value: number) => Math.max(step, Math.floor(value / step) * step);
  const up = (value: number) => Math.ceil(value / step) * step;
  const p25 = down(percentile(kept, 0.25));
  const p75 = Math.max(p25, up(percentile(kept, 0.75)));
  return { low: Math.min(p25, down(kept[0] ?? p25)), high: Math.max(p75, up(kept.at(-1) ?? p75)), p25, p75, count: sorted.length };
}

/** One comparable listing: its price and its seller (`sellerPublicId`). */
export interface ComparablePrice {
  price: number;
  seller: string;
}

/**
 * The range of `comparables` (most recent first), each seller counted for PRICE_GUIDE_MAX_PER_SELLER
 * prices at most; null below PRICE_GUIDE_MIN_SELLERS sellers or PRICE_GUIDE_MIN_COMPARABLES prices.
 */
export function comparableStats(comparables: readonly ComparablePrice[]): PriceStats | null {
  const perSeller = new Map<string, number>();
  const prices: number[] = [];
  for (const { price, seller } of comparables) {
    if (!seller || !Number.isFinite(price) || price <= 0) continue;
    const taken = perSeller.get(seller) ?? 0;
    if (taken >= PRICE_GUIDE_MAX_PER_SELLER) continue;
    perSeller.set(seller, taken + 1);
    prices.push(price);
  }
  if (perSeller.size < PRICE_GUIDE_MIN_SELLERS) return null;
  return priceStats(prices);
}

/** The guide of a listing as the listing page shows it. */
export interface PriceGuide extends PriceStats {
  scope: PriceGuideScope;
  /** The area: the city slug, the region code, or "ma". */
  place: string;
}

/** Where `price` sits on the guide's scale, 0 (low) to 1 (high), clamped. */
export function scalePosition(guide: Pick<PriceStats, "low" | "high">, price: number): number {
  if (guide.high <= guide.low) return 0.5;
  return Math.min(1, Math.max(0, (price - guide.low) / (guide.high - guide.low)));
}

/** Below, within or above the typical range: a position, never a judgement. */
export function rangePosition(guide: Pick<PriceStats, "p25" | "p75">, price: number): "below" | "within" | "above" {
  if (price < guide.p25) return "below";
  if (price > guide.p75) return "above";
  return "within";
}
