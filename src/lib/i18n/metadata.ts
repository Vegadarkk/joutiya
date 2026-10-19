import type { Metadata, Viewport } from "next";
import { getTranslations } from "next-intl/server";
import { CANONICAL_ORIGIN, HREFLANG_LOCALES, LOCALE_TAGS, type Locale } from "@/config/site";

/**
 * Base of canonical and hreflang URLs. A constant on purpose: public pages are prerendered once
 * for staging and production (one image, §2), so a runtime value would bake the build host in.
 * Staging is noindex anyway.
 */
export function siteUrl(): URL {
  return new URL(CANONICAL_ORIGIN);
}

/** Canonical URL and hreflang alternates: fr and ar only, Tarifit stays out of the cluster. */
export function alternates(locale: Locale, path = ""): Metadata["alternates"] {
  const canonical = `/${locale}${path}`;
  if (!HREFLANG_LOCALES.includes(locale)) return { canonical };
  const languages: Record<string, string> = Object.fromEntries(HREFLANG_LOCALES.map((tag) => [LOCALE_TAGS[tag], `/${tag}${path}`]));
  languages["x-default"] = `/fr${path}`;
  return { canonical, languages };
}

/**
 * og:locale, spread into an `openGraph` object: language_TERRITORY (ogp.me), so fr_MA and ar_MA.
 * Tarifit's tag (rif-Latn) has a script, not a territory, and no valid value: no og:locale there.
 */
export function openGraphLocale(locale: Locale): { locale?: string } {
  const match = /^([a-z]{2})-([A-Z]{2})$/.exec(LOCALE_TAGS[locale]);
  return match ? { locale: `${match[1]}_${match[2]}` } : {};
}

export async function rootMetadata(locale: Locale): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    metadataBase: siteUrl(),
    title: { default: t("title"), template: t("titleTemplate") },
    description: t("description"),
    applicationName: "Joutiya",
    alternates: alternates(locale),
    icons: { icon: "/brand/joutiya-icon.svg" },
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: { siteName: "Joutiya", ...openGraphLocale(locale), type: "website" },
  };
}

/** Mobile browser chrome in the header's colour (surface-brand: cream-200, bab-800 in dark). */
export const SITE_VIEWPORT: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2e9d8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b3a3c" },
  ],
};
