import {
  FLASH_MAX_MS,
  PROMO_AHEAD_MS,
  PROMO_GAP_MS,
  PROMO_MAX_MS,
  PROMO_MIN_MS,
  PROMO_REVIEW_PERCENT,
  percentOff,
  type ListingVariants,
  type PromoInput,
  type PromoView,
} from "@/lib/contracts/catalog";
import type { ListingPromo, PriceLogEntry } from "@/lib/db/schemas";
import { effectivePrices } from "./catalog";

// Promotions of a Pro listing (catalogue §4, owner decisions 2-4; law 31-08 art. 53-55), pure: the
// struck-out price is the lowest price of the 30 days before the start, computed here from the
// price log and stored with the promotion, never typed by the Pro. A listing published less than
// 30 days before (or without a log for a price) shows its promotion without a struck-out price.
// One promotion at a time, 1 hour to 30 days (72 hours for a flash sale), 7 days between two.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Window of the reference price (art. 54). */
export const REFERENCE_DAYS = 30;
/** Clock skew tolerated on a start typed as "now". */
const START_SKEW_MS = 5 * 60 * 1000;

type PromoListing = {
  price: number | null;
  isDonation: boolean;
  variants?: ListingVariants | undefined;
  priceLog?: PriceLogEntry[] | undefined;
  publishedAt?: Date | undefined;
  promo?: ListingPromo | undefined;
  lastPromoEndedAt?: Date | undefined;
};

/**
 * Lowest price of each key over the 30 days before `at`: the point in force when the window
 * opens, the points inside, the current price. Null for a key whose history is shorter (listing
 * published later, no point before the window).
 */
export function referencePrices(listing: PromoListing, at: Date): Map<string, number | null> {
  const opens = at.getTime() - REFERENCE_DAYS * DAY_MS;
  const references = new Map<string, number | null>();
  const old = listing.publishedAt !== undefined && listing.publishedAt.getTime() <= opens;
  const log = [...(listing.priceLog ?? [])].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const [key, current] of effectivePrices(listing)) {
    const points = log.filter((entry) => (entry.key ?? "") === key && entry.at.getTime() <= at.getTime());
    const inForce = points.filter((entry) => entry.at.getTime() <= opens).at(-1);
    if (!old || !inForce || current === null) {
      references.set(key, null);
      continue;
    }
    const prices = [inForce, ...points.filter((entry) => entry.at.getTime() > opens)].map((entry) => entry.price).filter((price): price is number => price !== null);
    references.set(key, Math.min(current, ...prices));
  }
  return references;
}

/** End of the last promotion that ran, the stored one included once ended. */
export function lastPromoEnd(listing: Pick<PromoListing, "promo" | "lastPromoEndedAt">, now: Date): Date | undefined {
  const ended = listing.promo && listing.promo.endsAt.getTime() <= now.getTime() ? listing.promo.endsAt : undefined;
  if (!ended) return listing.lastPromoEndedAt;
  if (!listing.lastPromoEndedAt) return ended;
  return ended > listing.lastPromoEndedAt ? ended : listing.lastPromoEndedAt;
}

/** The earliest start of a new promotion (decision 4: 7 days after the last one), or now. */
export function nextPromoFrom(listing: Pick<PromoListing, "promo" | "lastPromoEndedAt">, now: Date): Date {
  const last = lastPromoEnd(listing, now);
  const from = last ? new Date(last.getTime() + PROMO_GAP_MS) : now;
  return from > now ? from : now;
}

export type PromoIssueCode =
  | "promo_no_price"
  | "promo_exists"
  | "promo_start_past"
  | "promo_start_far"
  | "promo_end_before_start"
  | "promo_too_short"
  | "promo_too_long"
  | "promo_flash_too_long"
  | "promo_gap"
  | "promo_price_with_variants"
  | "promo_not_lower"
  | "promo_not_below_reference";

export interface PromoIssue {
  path: string;
  code: PromoIssueCode;
  /** The value that explains the refusal: the earliest start (ISO), or the price to go under. */
  value?: string;
}

export type PromoPlan = { ok: true; promo: ListingPromo; review: boolean; percent: number } | { ok: false; issues: PromoIssue[] };

/**
 * The promotion to store for `input`, or why it is refused. `review`: the deepest cut, against
 * the struck-out price (else the current one), passes PROMO_REVIEW_PERCENT (a moderator checks it).
 */
export function planPromo(listing: PromoListing, input: PromoInput, now: Date): PromoPlan {
  const issues: PromoIssue[] = [];
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  const endsAt = new Date(input.endsAt);
  const prices = effectivePrices(listing);
  if (listing.isDonation || [...prices.values()].some((price) => price === null)) return { ok: false, issues: [{ path: "price", code: "promo_no_price" }] };
  if (listing.promo && listing.promo.endsAt.getTime() > now.getTime()) issues.push({ path: "promo", code: "promo_exists" });
  if (startsAt.getTime() < now.getTime() - START_SKEW_MS) issues.push({ path: "startsAt", code: "promo_start_past" });
  if (startsAt.getTime() > now.getTime() + PROMO_AHEAD_MS) issues.push({ path: "startsAt", code: "promo_start_far" });
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration <= 0) issues.push({ path: "endsAt", code: "promo_end_before_start" });
  else if (duration < PROMO_MIN_MS) issues.push({ path: "endsAt", code: "promo_too_short" });
  else if (input.kind === "flash" && duration > FLASH_MAX_MS) issues.push({ path: "endsAt", code: "promo_flash_too_long" });
  else if (duration > PROMO_MAX_MS) issues.push({ path: "endsAt", code: "promo_too_long" });
  const from = nextPromoFrom(listing, now);
  if (startsAt.getTime() < from.getTime() - START_SKEW_MS && from > now) issues.push({ path: "startsAt", code: "promo_gap", value: from.toISOString() });
  if (input.price !== undefined && listing.variants) issues.push({ path: "price", code: "promo_price_with_variants" });
  if (issues.length > 0) return { ok: false, issues };

  const references = referencePrices(listing, startsAt > now ? now : startsAt);
  const entries: ListingPromo["prices"] = [];
  let deepest = 0;
  for (const [key, current] of prices) {
    const before = current as number;
    const price = input.price ?? Math.max(1, Math.floor((before * (100 - (input.percent ?? 0))) / 100));
    const reference = references.get(key) ?? null;
    if (price >= before) issues.push({ path: input.price !== undefined ? "price" : "percent", code: "promo_not_lower", value: String(before) });
    else if (reference !== null && price >= reference) issues.push({ path: input.price !== undefined ? "price" : "percent", code: "promo_not_below_reference", value: String(reference) });
    deepest = Math.max(deepest, percentOff(price, reference ?? before));
    entries.push({ key, price, reference });
  }
  if (issues.length > 0) return { ok: false, issues: [issues[0]!] };
  const promo: ListingPromo = { kind: input.kind, startsAt, endsAt, ...(input.percent !== undefined ? { percent: input.percent } : {}), prices: entries };
  return { ok: true, promo, review: deepest > PROMO_REVIEW_PERCENT, percent: deepest };
}

/**
 * Fields that end a promotion (cancelled by the Pro, or a price change: the struck-out price no
 * longer holds). One that has not started leaves no gap to wait.
 */
export function promoEnd(listing: Pick<PromoListing, "promo" | "lastPromoEndedAt">, now: Date): { promo: null; lastPromoEndedAt?: Date } | null {
  if (!listing.promo) return null;
  if (listing.promo.startsAt.getTime() > now.getTime()) return { promo: null };
  const end = listing.promo.endsAt < now ? listing.promo.endsAt : now;
  return { promo: null, lastPromoEndedAt: listing.lastPromoEndedAt && listing.lastPromoEndedAt > end ? listing.lastPromoEndedAt : end };
}

/** Promotion as the client views show it (dates as epoch ms), or null once ended. */
export function promoView(promo: ListingPromo | undefined, now: Date): PromoView | null {
  if (!promo || promo.endsAt.getTime() <= now.getTime()) return null;
  return { kind: promo.kind, startsAt: promo.startsAt.getTime(), endsAt: promo.endsAt.getTime(), prices: promo.prices };
}
