import { use } from "react";
import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Container } from "@/components/layout/container";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { pageLocale } from "@/i18n/params";

// Placeholder until phase 4 (Meilisearch). Static: the query string is ignored.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Search" });
  return { title: t("title"), robots: { index: false, follow: true } };
}

export default function SearchPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale(use(params).locale);
  setRequestLocale(locale);
  const t = useTranslations("Search");
  return (
    <Container>
      <EmptyState
        headingLevel="h1"
        title={t("emptyTitle")}
        action={
          <Button asChild variant="outline">
            <Link href="/">{t("backHome")}</Link>
          </Button>
        }
      >
        {t("emptyBody")}
      </EmptyState>
    </Container>
  );
}
