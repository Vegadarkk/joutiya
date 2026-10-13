import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { LEGAL_PAGES, legalPage } from "@/config/legal-pages";
import { LEGAL_TEXTS } from "@/content/legal/fr";
import { legalValues, mentionsText } from "@/content/legal/mentions";
import { LegalPage } from "@/components/legal/legal-page";
import { getLegalConfig } from "@/lib/legal/config";
import { alternates } from "@/lib/i18n/metadata";

// The 12 legal pages (§7). ISR: config/legal is editable without a redeploy and cached 5 minutes
// server side, so the pages follow it within 5 minutes.
export const revalidate = 300;
export const dynamicParams = false;

const MENTIONS_UPDATED = "2026-10-13";

export function generateStaticParams() {
  return LEGAL_PAGES.map((page) => ({ page: page.slug }));
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
  const [config, t] = await Promise.all([getLegalConfig(), getTranslations({ locale, namespace: "Footer.links" })]);
  const text = page.slug === "mentions-legales" ? mentionsText(config, MENTIONS_UPDATED) : LEGAL_TEXTS[page.slug];
  return <LegalPage locale={locale} title={t(page.key)} text={text} values={legalValues(config)} />;
}
