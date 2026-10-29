// Morocco's clock without trusting the runtime's time zone data. Morocco moved to permanent UTC+0
// on 20 September 2026 at 02:00 local time (tzdata 2026c), but browsers ship time zone data late:
// on 29 October 2026, Chrome 153 still put Africa/Casablanca at UTC+1, so every time of day
// rendered in the browser (appointments, message times) was one hour late, and the slot picker
// stored slots one hour early. From the switch on, Morocco's time is UTC; before it,
// Africa/Casablanca, whose history is the same in every version of the data. If Morocco changes
// its clock again, update this file: browsers will lag behind the new data again. Pure.

export const MOROCCO_TIME_ZONE = "Africa/Casablanca";

/** 20 September 2026, 02:00 at UTC+1. */
export const MOROCCO_UTC_SINCE = Date.UTC(2026, 8, 20, 1);

/** The `timeZone` that gives Morocco's wall clock at `at` (epoch ms). */
export function moroccoTimeZone(at: number): string {
  return at >= MOROCCO_UTC_SINCE ? "UTC" : MOROCCO_TIME_ZONE;
}
