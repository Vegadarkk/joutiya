import { RENTAL_SEARCH_AHEAD_DAYS, RENTAL_SEARCH_DAYS_MAX, dayNumber } from "@/lib/listings/rental-availability";

// Booking request rules shared by the listing page's dialog, the thread and the server (rental
// pack §6; a holiday home's stay: seasonal rental conception §3). Pure and zod-free: the listing
// page's islands import them (contracts/rental-requests.ts re-exports them with the schemas).

export const RENTAL_REQUEST_STATUSES = ["requested", "accepted", "declined", "withdrawn"] as const;
export type RentalRequestStatus = (typeof RENTAL_REQUEST_STATUSES)[number];

/** What a system message of the thread says about the request. */
export const RENTAL_REQUEST_EVENTS = ["requested", "changed", "accepted", "declined", "withdrawn"] as const;
export type RentalRequestEvent = (typeof RENTAL_REQUEST_EVENTS)[number];

export const RENTAL_PICKUP_MAX = 120;

/** Stored text of a request system message: the UI renders it localized (inbox preview too). */
export const rentalRequestMarker = (event: RentalRequestEvent) => `⟦location:${event}⟧`;
const MARKER = /^⟦location:([a-z_]+)⟧$/;

/** The event of a request marker text, else null. */
export function rentalRequestEventOf(text: string): RentalRequestEvent | null {
  const event = MARKER.exec(text)?.[1];
  return (RENTAL_REQUEST_EVENTS as readonly string[]).includes(event ?? "") ? (event as RentalRequestEvent) : null;
}

export type RentalRequestProblem = "invalid_day" | "reversed" | "past" | "too_far" | "too_long";

/**
 * Why a request for `from`-`to` cannot be sent on `today` (a day number), else null: the same
 * bounds as a search by dates (a pick-up within 180 days, at most 60 days of rental). A stay
 * (`unit` night) leaves on a later day than it arrives.
 */
export function rentalRequestProblem(dates: { from: string; to: string }, today: number, unit: "day" | "night" = "day"): RentalRequestProblem | null {
  const from = dayNumber(dates.from);
  const to = dayNumber(dates.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return "invalid_day";
  if (to < from || (unit === "night" && to === from)) return "reversed";
  if (from < today) return "past";
  if (from > today + RENTAL_SEARCH_AHEAD_DAYS) return "too_far";
  if (to - from > RENTAL_SEARCH_DAYS_MAX) return "too_long";
  return null;
}

/** The request card stays pinned in the thread: unanswered with a pick-up still ahead, or accepted until the return day. */
export function rentalRequestOpen(request: { status: RentalRequestStatus; from: string; to: string }, today: number): boolean {
  if (request.status === "requested") return dayNumber(request.from) >= today;
  if (request.status === "accepted") return dayNumber(request.to) >= today;
  return false;
}
