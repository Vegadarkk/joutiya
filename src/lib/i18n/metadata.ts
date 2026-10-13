import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HREFLANG_LOCALES, LOCALE_TAGS, type Locale } from "@/config/site";

export function siteUrl(): URL {
  return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
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
