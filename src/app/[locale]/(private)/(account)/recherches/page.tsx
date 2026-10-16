import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { SavedSearchesView } from "@/components/saved-searches/saved-searches-view";
import { pageLocale } from "@/i18n/params";

// /recherches (design D18): the saved searches and their daily alerts, read from /api/saved-searches.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "SavedSearches.page" });
  return { title: t("title") };
}

export default async function SavedSearchesPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-3xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <SavedSearchesView />
    </Container>
  );
}
