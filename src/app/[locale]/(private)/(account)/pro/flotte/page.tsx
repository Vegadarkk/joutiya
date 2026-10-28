import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { FleetPlanning } from "@/components/rental/fleet-planning";
import { textLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { cn } from "@/lib/utils";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Fleet" });
  return { title: t("title") };
}

// /pro/flotte: fleet planning of a car rental agency (rental pack §3).
export default async function FleetPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Fleet" });
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-7xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <Link href="/pro" className={cn("mb-6 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
        <ArrowLeft aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
        {t("back")}
      </Link>
      <header className="mb-8 flex max-w-3xl flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      <FleetPlanning />
    </Container>
  );
}
