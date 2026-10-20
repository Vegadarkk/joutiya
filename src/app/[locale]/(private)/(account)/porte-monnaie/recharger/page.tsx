import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { PackPicker } from "@/components/payments/pack-picker";
import { pageLocale } from "@/i18n/params";
import { getLegalConfig } from "@/lib/legal/config";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Packs" });
  return { title: t("metaTitle") };
}

export default async function BuyCreditsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const legal = await getLegalConfig();
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-3xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <PackPicker contactEmail={legal.email} />
    </Container>
  );
}
