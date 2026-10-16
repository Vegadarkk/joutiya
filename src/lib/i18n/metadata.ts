import type { Metadata } from "next";
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
    openGraph: { siteName: "Joutiya", locale: LOCALE_TAGS[locale].replace("-", "_"), type: "website" },
  };
}
