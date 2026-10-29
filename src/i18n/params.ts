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
 * Build-time params of a public page: every locale, times the page's own params when it has a
 * dynamic segment. Each page built ahead returns it from its own generateStaticParams; the
 * (public) layout gives none, because a parent's params are always prerendered and a child's
 * empty list cannot remove them (Next.js passes the parent's params through). So the home,
 * rendered on its first visit only, returns [] and stays out of the build.
 */
export function localeParams<T extends Record<string, string> = Record<never, never>>(params: readonly T[] = [{} as T]): ({ locale: Locale } & T)[] {
  return routing.locales.flatMap((locale) => params.map((param) => ({ locale, ...param })));
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
