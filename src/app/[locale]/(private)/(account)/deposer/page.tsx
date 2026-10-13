import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Container } from "@/components/layout/container";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { pageLocale } from "@/i18n/params";

// Placeholder until phase 3 (listing wizard).

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Nav" });
  return { title: t("post") };
}

export default async function PostPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Private" });
  const nav = await getTranslations({ locale, namespace: "Search" });
  return (
    <Container>
      <EmptyState
        headingLevel="h1"
        title={t("postTitle")}
        action={
          <Button asChild variant="outline">
            <Link href="/">{nav("backHome")}</Link>
          </Button>
        }
      >
        {t("postBody")}
      </EmptyState>
    </Container>
  );
}
