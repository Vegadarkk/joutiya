import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { Container } from "@/components/layout/container";
import { Skeleton } from "@/components/ui/skeleton";
import { WizardStart } from "@/components/post/start";
import { PostWizard } from "@/components/post/wizard";
import { pageLocale } from "@/i18n/params";
import { parseWizardPath } from "@/lib/listings/client/routes";

// Posting wizard (design D3): `/deposer` (resume or start), `/deposer/{id}`, `/deposer/{id}/{step}`,
// `/deposer/{id}/termine`. The server only validates the URL (404 on an unknown id or step) and
// renders the client shell; the listing itself is fetched from the API by the browser.

type Props = { params: Promise<{ locale: string; path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Listing.wizard" });
  return { title: t("title") };
}

export default async function PostPage({ params }: Props) {
  const { locale: rawLocale, path } = await params;
  const locale = pageLocale(rawLocale);
  setRequestLocale(locale);
  const parsed = parseWizardPath(["deposer", ...(path ?? [])].join("/"));
  if (parsed.invalid) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // Tarifit: the account pages are French until a native review (see FrenchOnlyNotice).
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-4xl py-8 lg:py-12">
      <FrenchOnlyNotice className="mb-8" />
      {parsed.id ? (
        <PostWizard listingId={parsed.id} nonce={nonce} />
      ) : (
        <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" />}>
          <WizardStart />
        </Suspense>
      )}
    </Container>
  );
}
