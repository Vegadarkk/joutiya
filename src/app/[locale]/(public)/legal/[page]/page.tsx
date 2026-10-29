import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { localeParams } from "@/i18n/params";
import { LEGAL_PAGES, legalPage } from "@/config/legal-pages";
import { ARABIC_LEGAL_PAGES, LEGAL_VERSIONS, PROVISIONAL_LEGAL_PAGES } from "@/config/legal-versions";
import { LegalPage } from "@/components/legal/legal-page";
import { getFlags } from "@/lib/config/runtime";
import { getLegalConfig } from "@/lib/legal/config";
import { parseMarkdown } from "@/lib/legal/markdown";
import { legalSource } from "@/lib/legal/sources";
import { renderTemplate } from "@/lib/legal/template";
import { legalScope } from "@/lib/legal/values";
import { alternates } from "@/lib/i18n/metadata";
import { isPhoneVerificationConfigured } from "@/lib/phone-verify/config";

// The 12 legal pages (§7, phase 6 D11): Markdown sources in src/content/legal/{fr,ar}, filled from
// config/legal and the live switches (WhatsApp, ads). ISR: config/legal and the flags are cached 5
// minutes server side, so the pages follow them within 5 minutes, without a redeploy.
export const revalidate = 300;
export const dynamicParams = false;

export function generateStaticParams() {
  return localeParams(LEGAL_PAGES.map((page) => ({ page: page.slug })));
}

type Params = Promise<{ locale: string; page: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, page: slug } = await params;
  const page = legalPage(slug);
  if (!page || !hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Footer.links" });
  return { title: t(page.key), alternates: alternates(locale, `/legal/${page.slug}`) };
}

export default async function LegalRoute({ params }: { params: Params }) {
  const { locale, page: slug } = await params;
  const page = legalPage(slug);
  if (!page || !hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Arabic where the text exists; French everywhere else (the Tarifit site included).
  const language = locale === "ar" && ARABIC_LEGAL_PAGES.has(page.slug) ? "ar" : "fr";
  const [config, flags] = await Promise.all([getLegalConfig(), getFlags()]);
  const scope = legalScope(
    config,
    { whatsapp: isPhoneVerificationConfigured(), ads: flags.adsMode !== "off", adsCmpEea: flags.adsCmpEea },
    LEGAL_VERSIONS[page.slug],
    language,
  );
  const { text } = renderTemplate(legalSource(page.slug, language), scope, { isolate: language === "ar" });
  return (
    <LegalPage
      blocks={parseMarkdown(text)}
      language={language}
      translated={language === "ar"}
      frenchOnly={locale !== "fr" && language === "fr"}
      provisional={PROVISIONAL_LEGAL_PAGES.has(page.slug)}
    />
  );
}
