import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ActionView } from "@/components/auth/action-view";
import { AuthShell } from "@/components/auth/auth-shell";
import { KhatamLoader } from "@/components/ui/khatam-loader";
import { pageLocale } from "@/i18n/params";

// Target of the verification and reset e-mails. Only `mode` is read here, for the title; the
// one-time code stays in the browser (ActionView posts it to the API).

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ mode?: string | string[] }> };

async function titleFor(locale: "fr" | "ar" | "rif", mode: string | string[] | undefined): Promise<string> {
  const t = await getTranslations({ locale, namespace: "Auth.action" });
  return mode === "resetPassword" ? t("resetTitle") : t("title");
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  return { title: await titleFor(locale, (await searchParams).mode) };
}

export default async function ActionPage({ params, searchParams }: Props) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const title = await titleFor(locale, (await searchParams).mode);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell title={title}>
      <Suspense fallback={<KhatamLoader />}>
        <ActionView nonce={nonce} />
      </Suspense>
    </AuthShell>
  );
}
