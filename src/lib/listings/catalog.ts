import type { ListingVariants } from "@/lib/contracts/catalog";
import { PRICE_LOG_MAX, type PriceLogEntry } from "@/lib/db/schemas";

// Price history of a listing (catalogue-boutique.md §4): a point per change once published, so
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
 * force when the window opens. Over PRICE_LOG_MAX, the oldest points go first.
 */
export function prunePriceLog(log: readonly PriceLogEntry[], now: Date): PriceLogEntry[] {
  const since = now.getTime() - PRICE_LOG_DAYS * DAY_MS;
  const sorted = [...log].sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastBefore = new Map<string, PriceLogEntry>();
  for (const entry of sorted) if (entry.at.getTime() < since) lastBefore.set(entry.key ?? LISTING_KEY, entry);
  const kept = sorted.filter((entry) => entry.at.getTime() >= since || lastBefore.get(entry.key ?? LISTING_KEY) === entry);
  return kept.slice(-PRICE_LOG_MAX);
}

/** The log with a point for every key whose price differs from its last point (an equal log when nothing changed). */
export function logPrices(log: readonly PriceLogEntry[] | undefined, listing: Priced, now: Date): PriceLogEntry[] | undefined {
  const current = log ?? [];
  const last = new Map<string, number | null>();
  for (const entry of [...current].sort((a, b) => a.at.getTime() - b.at.getTime())) last.set(entry.key ?? LISTING_KEY, entry.price);
  const points: PriceLogEntry[] = [];
  for (const [key, price] of effectivePrices(listing)) {
    if (last.has(key) && last.get(key) === price) continue;
    points.push({ at: now, price, ...(key === LISTING_KEY ? {} : { key }) });
  }
  if (points.length === 0) return log ? [...log] : undefined;
  return prunePriceLog([...current, ...points], now);
}
