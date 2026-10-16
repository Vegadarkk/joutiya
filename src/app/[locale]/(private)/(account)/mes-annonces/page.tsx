import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { PageSkeleton } from "@/components/feedback/skeletons";
import { MyListingsView } from "@/components/listings/owner/my-listings-view";
import { pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "MyListings" });
  return { title: t("title") };
}

export default async function MyListingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-3xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      {/* useSearchParams (the selected tab) needs a Suspense boundary (design §8). */}
      <Suspense fallback={<PageSkeleton />}>
        <MyListingsView />
      </Suspense>
    </Container>
  );
}
