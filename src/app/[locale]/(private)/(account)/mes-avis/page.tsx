import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { MyReviewsView } from "@/components/reviews/my-reviews-view";
import { pageLocale } from "@/i18n/params";

// /mes-avis (vitrine-avis §2): the reviews the member received and gave, read in the browser from
// GET /api/account/reviews.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Reviews.mine" });
  return { title: t("title") };
}

export default async function MyReviewsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-3xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <MyReviewsView />
    </Container>
  );
}
