import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import type { Locale } from "@/config/site";
import { routing } from "./routing";

/** The [locale] param as a Locale; an unknown value is a 404 (layouts already reject it). */
export function pageLocale(value: string): Locale {
  if (!hasLocale(routing.locales, value)) notFound();
  return value;
}

/**
 * Locale of the translations that print numbers (ICU `#`) and of Intl dates and numbers. Tarifit
 * has no Intl data: under "rif" the runtime default formats them (en-US: "1,200 annonces",
 * "October 13, 2026", English plural rules) while the text is the French fallback (Z9). For
 * translations, only namespaces without Tarifit text (rif.json): their French catalog is then
 * exactly what the page shows. The request locale stays "rif" (routing, links).
 */
export function numbersLocale(locale: Locale): Locale {
  return locale === "rif" ? "fr" : locale;
}
