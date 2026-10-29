import type { Metadata, Viewport } from "next";
import { getTranslations } from "next-intl/server";
import { CANONICAL_ORIGIN, SITE_NAME, HREFLANG_LOCALES, LOCALE_TAGS, type Locale } from "@/config/site";

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
 * The site has its own dark theme and a light/dark/system switch: a Dark Reader-style extension
 * would recolour the brand on top of it and override a visitor's light choice. Its lock tag keeps it off
 * (the extension reads only the name; Next drops a meta with empty content).
 */
export const DARK_READER_LOCK: Metadata["other"] = { "darkreader-lock": "true" };

export async function rootMetadata(locale: Locale): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    metadataBase: siteUrl(),
    title: { default: t("title"), template: t("titleTemplate") },
    description: t("description"),
    applicationName: SITE_NAME,
    alternates: alternates(locale),
    icons: { icon: "/brand/aalan-icon.svg" },
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: { siteName: SITE_NAME, locale: LOCALE_TAGS[locale].replace("-", "_"), type: "website" },
    other: DARK_READER_LOCK,
  };
}

/** Mobile browser chrome in the header's colour (surface-brand: cream-200, bab-800 in dark). */
export const SITE_VIEWPORT: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2e9d8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b3a3c" },
  ],
};
