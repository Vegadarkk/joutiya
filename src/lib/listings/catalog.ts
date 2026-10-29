import type { ListingVariants } from "@/lib/contracts/catalog";
import { PRICE_LOG_MAX } from "@/lib/contracts/catalog-core";
import type { PriceLogEntry } from "@/lib/db/schemas";

// Price history of a listing (catalogue-boutique.md §4): a point per price buyers see, so
// the struck-out price of a promotion can be the lowest of the last 30 days (art. 54 of law 31-08)
// and never a figure the Pro types. Pure: the service writes the result with the listing.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Window kept: 30 days of reference, one day of margin. */
export const PRICE_LOG_DAYS = 31;

type Priced = { price: number | null; isDonation: boolean; variants?: ListingVariants | undefined };

/** Key of a listing's own price in the log (a combination uses its variant key). */
const LISTING_KEY = "";

/** Price shown for each key: the listing's (key ""), or each combination's (its own, else the listing's). */
export function effectivePrices(listing: Priced): Map<string, number | null> {
  const prices = new Map<string, number | null>();
  const base = listing.isDonation ? null : listing.price;
  if (listing.variants) for (const item of listing.variants.items) prices.set(item.key, item.price ?? base);
  else prices.set(LISTING_KEY, base);
  return prices;
}

/**
 * Points older than the window go, but the newest of them for each key stays: it is the price in
 * force when the window opens. Over PRICE_LOG_MAX, the points no reference can need go first
 * (`withoutDominated`), then the oldest: a key losing its first points loses its struck-out price,
 * never gets a higher one.
 */
export function prunePriceLog(log: readonly PriceLogEntry[], now: Date): PriceLogEntry[] {
  const since = now.getTime() - PRICE_LOG_DAYS * DAY_MS;
  const sorted = [...log].sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastBefore = new Map<string, PriceLogEntry>();
  for (const entry of sorted) if (entry.at.getTime() < since) lastBefore.set(entry.key ?? LISTING_KEY, entry);
  const kept = sorted.filter((entry) => entry.at.getTime() >= since || lastBefore.get(entry.key ?? LISTING_KEY) === entry);
  return (kept.length > PRICE_LOG_MAX ? withoutDominated(kept) : kept).slice(-PRICE_LOG_MAX);
}

/**
 * The log without the priced points followed, for their key, by a point at or below their price:
 * that later point is in every window holding the first, so no lowest price changes. The first
 * point of each key stays (the price in force when a window opens before the next one).
 */
function withoutDominated(sorted: readonly PriceLogEntry[]): PriceLogEntry[] {
  const first = new Map<string, PriceLogEntry>();
  for (const entry of sorted) if (!first.has(entry.key ?? LISTING_KEY)) first.set(entry.key ?? LISTING_KEY, entry);
  const lowestLater = new Map<string, number>();
  const kept: PriceLogEntry[] = [];
  for (const entry of [...sorted].reverse()) {
    const key = entry.key ?? LISTING_KEY;
    const later = lowestLater.get(key);
    if (entry.price === null || later === undefined || later > entry.price || first.get(key) === entry) kept.push(entry);
    if (entry.price !== null) lowestLater.set(key, Math.min(later ?? entry.price, entry.price));
  }
  return kept.reverse();
}

/** Points for every key whose price differs from its last point. */
function newPoints(log: readonly PriceLogEntry[], listing: Priced, now: Date): PriceLogEntry[] {
  const last = new Map<string, number | null>();
  for (const entry of [...log].sort((a, b) => a.at.getTime() - b.at.getTime())) last.set(entry.key ?? LISTING_KEY, entry.price);
  const points: PriceLogEntry[] = [];
  for (const [key, price] of effectivePrices(listing)) {
    if (last.has(key) && last.get(key) === price) continue;
    points.push({ at: now, price, ...(key === LISTING_KEY ? {} : { key }) });
  }
  return points;
}

/** The log with a point for every key whose price differs from its last point (an equal log when nothing changed). */
export function logPrices(log: readonly PriceLogEntry[] | undefined, listing: Priced, now: Date): PriceLogEntry[] | undefined {
  const points = newPoints(log ?? [], listing, now);
  if (points.length === 0) return log ? [...log] : undefined;
  return prunePriceLog([...(log ?? []), ...points], now);
}

/**
 * The log of a listing whose prices buyers see from `now` (B-03, art. 54: only prices actually
 * shown count): written when it goes live (published, resumed, renewed, approved, restored) and
 * on a price change while it stays published, never while paused, expired or held. Undefined
 * when no point is added.
 */
export function livePriceLog(listing: Priced & { priceLog?: PriceLogEntry[] | undefined }, now: Date): PriceLogEntry[] | undefined {
  const points = newPoints(listing.priceLog ?? [], listing, now);
  return points.length === 0 ? undefined : prunePriceLog([...(listing.priceLog ?? []), ...points], now);
}
