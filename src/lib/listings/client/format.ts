import { LOCALE_TAGS, type Locale } from "@/config/site";

// Number and date formatting of the listing UI. Prices are integer MAD shown as "1 500 DH"
// (fr) / "1 500 درهم" (ar, Western digits): fr-MA CLDR would give "1.500 MAD", so the grouping is
// ours. Tarifit has no Intl data and uses the French forms.

const GROUP_SEPARATOR = " "; // narrow no-break space

/** "1500000" -> "1 500 000" (digits only in, grouped out). */
export function groupDigits(digits: string): string {
  const clean = digits.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!clean) return "";
  return clean.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
}

/** Digits typed in the price field (spaces, dots, Arabic-Indic digits accepted) -> integer MAD, or null when empty. */
export function parsePriceInput(text: string): number | null {
  const western = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const digits = western.replace(/\D/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

export function currencyLabel(locale: Locale): string {
  return locale === "ar" ? "درهم" : "DH";
}

/** "1 500 DH" / "1 500 درهم". */
export function formatPrice(amount: number, locale: Locale): string {
  const grouped = groupDigits(String(Math.max(0, Math.trunc(amount))));
  return `${grouped || "0"} ${currencyLabel(locale)}`;
}

export function intlLocale(locale: Locale): string {
  return locale === "ar" ? LOCALE_TAGS.ar : LOCALE_TAGS.fr;
}

/** Whole days from `now` to `date` (negative in the past). */
export function daysUntil(date: Date, now: Date = new Date()): number {
  return Math.round((date.getTime() - now.getTime()) / 86_400_000);
}

/** "dans 12 jours" / "il y a 3 jours" (fr) or the Arabic forms. */
export function formatRelativeDays(days: number, locale: Locale): string {
  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
  if (Math.abs(days) >= 60) return formatter.format(Math.round(days / 30), "month");
  return formatter.format(days, "day");
}

export function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Casablanca" }).format(date);
}
