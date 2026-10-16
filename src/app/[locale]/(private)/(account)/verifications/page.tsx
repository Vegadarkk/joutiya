import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { VerificationsView } from "@/components/auth/verifications-view";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Auth.verifications" });
  return { title: t("title") };
}

export default async function VerificationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-2xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <VerificationsView />
    </Container>
  );
}
