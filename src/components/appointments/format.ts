import type { Locale } from "@/config/site";
import type { Slot } from "@/lib/contracts/appointments";
import { URL_MARKER } from "@/lib/contracts/messaging";
import { slotEnd } from "@/lib/appointments/rules";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { intlLocale } from "@/lib/listings/client/format";

// Slot dates in Morocco's time zone, whatever the device's zone (the appointment happens there).

const clock = (at: number, locale: Locale) =>
  new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: moroccoTimeZone(at) }).format(new Date(at));

/** "14:30 – 15:30". */
export function formatSlotRange(slot: Slot, locale: Locale): string {
  return `${clock(slot.start, locale)} – ${clock(slotEnd(slot), locale)}`;
}

/** "14:30". */
export const formatSlotClock = clock;

/** "jeudi 5 novembre". */
export function formatSlotDay(at: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: "long", day: "numeric", month: "long", timeZone: moroccoTimeZone(at) }).format(new Date(at));
}

/** Day tile parts of "YYYY-MM-DD": weekday "jeu.", day "5", month "nov.". */
export function dayTile(day: string, locale: Locale): { weekday: string; date: string; month: string } {
  const at = new Date(`${day}T12:00:00Z`);
  const tag = intlLocale(locale);
  return {
    weekday: new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: "UTC" }).format(at),
    date: new Intl.DateTimeFormat(tag, { day: "numeric", timeZone: "UTC" }).format(at),
    month: new Intl.DateTimeFormat(tag, { month: "short", timeZone: "UTC" }).format(at),
  };
}

/** "jeudi 5 novembre" of a "YYYY-MM-DD" day. */
export function formatDayKey(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** The place with its masked links shown as such. */
export const placeText = (place: string, masked: string) => place.split(URL_MARKER).join(masked);
