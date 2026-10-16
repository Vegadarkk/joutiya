import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageChallenge } from "@/components/challenge/page-challenge";
import { DoorMark } from "@/components/feedback/door-mark";
import { Container } from "@/components/layout/container";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { challengeNext } from "@/lib/security/challenge-path";

// Page challenge of the SSR limits (design D14). Private segment: dynamic, nonce CSP (the Turnstile
// script needs it), device cookie set by the proxy, noindex, disallowed in robots.txt. Never metered
// by the proxy, so it always answers.

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Challenge" });
  return { title: t("metaTitle") };
}

export default async function ChallengePage({ params, searchParams }: Props) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Challenge" });
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const raw = (await searchParams).next;
  const next = challengeNext(Array.isArray(raw) ? raw[0] : raw, locale);
  return (
    <Container lang={locale === "rif" ? "fr" : undefined} className="flex max-w-xl flex-1 flex-col justify-center py-12 lg:py-20">
      <div className="flex flex-col gap-6">
        <DoorMark className="w-14" />
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold text-balance sm:text-3xl">{t("title")}</h1>
          <p className="text-pretty text-foreground-muted">{t("lead")}</p>
        </div>
        <PageChallenge next={next} nonce={nonce} />
        <p className="border-t border-border pt-5 text-sm text-pretty text-foreground-muted">
          {t("why")}{" "}
          <Link href="/" className="font-medium text-link underline-offset-2 hover:underline">
            {t("home")}
          </Link>
        </p>
      </div>
    </Container>
  );
}
