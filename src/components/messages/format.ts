import type { Locale } from "@/config/site";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { intlLocale } from "@/lib/listings/client/format";
import { dayKey } from "./thread-state";

// Dates of the messaging pages, in Morocco's time zone (the server stores epoch ms).

const DAY_MS = 86_400_000;

/** "14:32". */
export function formatClock(at: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: moroccoTimeZone(at) }).format(new Date(at));
}

/** Inbox row: the time today, `yesterday` (translated) the day before, the weekday within a week, then the date. */
export function formatRowTime(at: number, now: number, locale: Locale, yesterday: string): string {
  const day = dayKey(at);
  if (day === dayKey(now)) return formatClock(at, locale);
  if (day === dayKey(now - DAY_MS)) return yesterday;
  const tag = intlLocale(locale);
  if (now - at < 6 * DAY_MS) return new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: moroccoTimeZone(at) }).format(new Date(at));
  const sameYear = day.slice(0, 4) === dayKey(now).slice(0, 4);
  return new Intl.DateTimeFormat(tag, sameYear ? { day: "numeric", month: "short", timeZone: moroccoTimeZone(at) } : { day: "numeric", month: "short", year: "numeric", timeZone: moroccoTimeZone(at) }).format(new Date(at));
}

/** Thread separator: `today` / `yesterday` (translated), else "lundi 12 octobre" (with the year when not this one). */
export function formatDayLabel(at: number, now: number, locale: Locale, labels: { today: string; yesterday: string }): string {
  const day = dayKey(at);
  if (day === dayKey(now)) return labels.today;
  if (day === dayKey(now - DAY_MS)) return labels.yesterday;
  const sameYear = day.slice(0, 4) === dayKey(now).slice(0, 4);
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }), timeZone: moroccoTimeZone(at) }).format(new Date(at));
}
