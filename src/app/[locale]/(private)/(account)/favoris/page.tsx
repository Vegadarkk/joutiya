import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { FavoritesView } from "@/components/favorites/favorites-view";
import { Container } from "@/components/layout/container";
import { pageLocale } from "@/i18n/params";

// /favoris (design D17): the account's favorites, read in the browser from GET /api/favorites.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Favorites.page" });
  return { title: t("title") };
}

export default async function FavoritesPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-4xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <FavoritesView />
    </Container>
  );
}
