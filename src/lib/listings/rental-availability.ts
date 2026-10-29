import { moroccoClock } from "@/lib/appointments/time";

// Car rental availability (rental pack §3): the agency blocks periods of days, Morocco's calendar,
// bounds included; a blocked day means no vehicle of the listing is free. Pure and client-safe:
// the API, the indexer, the owner calendar and the listing page share it.

/** Blocked periods kept per listing, after merging. */
export const RENTAL_PERIODS_MAX = 40;
/** Days ahead an agency can block, today included. */
export const RENTAL_AHEAD_DAYS = 365;
/** Availability not confirmed for this long reads "à confirmer" and ranks after the fresh ones (owner decision 4). */
export const RENTAL_FRESH_DAYS = 14;

/** Car rental dates of a search or a booking request (rental pack §4, §6): at most 60 days of rental, a start within 180 days. */
export const RENTAL_SEARCH_DAYS_MAX = 60;
export const RENTAL_SEARCH_AHEAD_DAYS = 180;

const DAY_MS = 86_400_000;
export const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface RentalPeriod {
  /** "YYYY-MM-DD", Morocco's calendar, first blocked day. */
  from: string;
  /** Last blocked day (included). */
  to: string;
}

/** Days since 1970-01-01 of a "YYYY-MM-DD" day; NaN when the day does not exist (2026-02-30). */
export function dayNumber(day: string): number {
  if (!DAY_PATTERN.test(day)) return Number.NaN;
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day ? Number.NaN : at / DAY_MS;
}

export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Rental days of a period: the return day minus the pick-up day, at least one. */
export function rentalDuration(dates: { from: string; to: string }): number {
  return Math.max(1, dayNumber(dates.to) - dayNumber(dates.from));
}

/** Today in Morocco, as a day number. */
export function moroccoToday(now: Date | number): number {
  return dayNumber(moroccoClock(typeof now === "number" ? now : now.getTime()).day);
}

export type PeriodsProblem = "invalid_day" | "reversed" | "too_far" | "too_many";

/**
 * The stored form of periods sent by an agency: past days dropped, overlapping or touching periods
 * merged, sorted. Refused: a day that does not exist, `to` before `from`, a day past the horizon,
 * more than RENTAL_PERIODS_MAX periods once merged.
 */
export function normalizePeriods(periods: readonly RentalPeriod[], today: number): { periods: RentalPeriod[] } | { problem: PeriodsProblem } {
  const last = today + RENTAL_AHEAD_DAYS - 1;
  const ranges: [number, number][] = [];
  for (const period of periods) {
    const from = dayNumber(period.from);
    const to = dayNumber(period.to);
    if (Number.isNaN(from) || Number.isNaN(to)) return { problem: "invalid_day" };
    if (to < from) return { problem: "reversed" };
    if (to > last) return { problem: "too_far" };
    if (to < today) continue;
    ranges.push([Math.max(from, today), to]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  if (merged.length > RENTAL_PERIODS_MAX) return { problem: "too_many" };
  return { periods: merged.map(([from, to]) => ({ from: dayString(from), to: dayString(to) })) };
}

/** Blocked day numbers from `today` on (search index `rentUnavailableDays`). */
export function blockedDays(periods: readonly RentalPeriod[], today: number): number[] {
  const days: number[] = [];
  for (const period of periods) {
    const from = Math.max(dayNumber(period.from), today);
    const to = dayNumber(period.to);
    for (let day = from; day <= to; day += 1) days.push(day);
  }
  return days;
}

/** The set of blocked day numbers, for calendars. */
export function blockedSet(periods: readonly RentalPeriod[]): Set<number> {
  return new Set(blockedDays(periods, Number.NEGATIVE_INFINITY));
}

/** Periods of a set of blocked days (calendar edits back to the stored form). */
export function periodsOf(days: Iterable<number>): RentalPeriod[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const periods: RentalPeriod[] = [];
  let start: number | undefined;
  let end = 0;
  for (const day of sorted) {
    if (start !== undefined && day === end + 1) {
      end = day;
      continue;
    }
    if (start !== undefined) periods.push({ from: dayString(start), to: dayString(end) });
    start = day;
    end = day;
  }
  if (start !== undefined) periods.push({ from: dayString(start), to: dayString(end) });
  return periods;
}

/** End of the fresh window of an availability confirmed at `updatedAt` (epoch ms). */
export function freshUntil(updatedAt: Date | number): number {
  return (typeof updatedAt === "number" ? updatedAt : updatedAt.getTime()) + RENTAL_FRESH_DAYS * DAY_MS;
}

export function isFresh(updatedAt: Date | number | null | undefined, now: Date | number): boolean {
  if (updatedAt === null || updatedAt === undefined) return false;
  return freshUntil(updatedAt) > (typeof now === "number" ? now : now.getTime());
}
