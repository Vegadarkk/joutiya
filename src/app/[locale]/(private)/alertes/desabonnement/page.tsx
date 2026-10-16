import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { UnsubscribeConfirm } from "@/components/alerts/unsubscribe-confirm";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { DoorMark } from "@/components/feedback/door-mark";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { describeUnsubscribe } from "@/lib/alerts/handlers";

// /alertes/desabonnement?t=<token> (design D20): the "Se désabonner" link of the alert e-mails.
// Private dynamic page (PRIVATE_SEGMENTS: nonce CSP, noindex), no session needed: the signed token
// names the alert. Reading the page changes nothing; the button posts the token.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Alerts.unsubscribe" });
  return { title: t("metaTitle") };
}

export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Alerts.unsubscribe" });
  const raw = (await searchParams).t;
  const token = typeof raw === "string" ? raw : undefined;
  const link = await describeUnsubscribe(token);

  let title: string;
  let body: string;
  if (link.kind === "all") {
    title = t("titleAll");
    body = t("bodyAll");
  } else if (link.kind === "one") {
    title = link.active ? t("titleOne", { name: link.name }) : t("alreadyOff", { name: link.name });
    body = link.active ? t("bodyOne") : t("alreadyOffBody");
  } else if (link.kind === "gone") {
    title = t("goneTitle");
    body = t("goneBody");
  } else {
    title = t("invalidTitle");
    body = t("invalidBody");
  }
  const canConfirm = token !== undefined && (link.kind === "all" || (link.kind === "one" && link.active));

  return (
    <Container lang={locale === "rif" ? "fr" : undefined} className="max-w-xl py-12 lg:py-16">
      <FrenchOnlyNotice className="mb-8" />
      <section className="flex flex-col items-center gap-5 rounded-lg border border-border bg-surface px-6 py-10 text-center shadow-sm shadow-bab-950/5 sm:px-10" data-testid="unsubscribe-page" data-kind={link.kind}>
        <DoorMark className="w-16" />
        <h1 className="text-2xl font-semibold text-balance">{title}</h1>
        <p className="max-w-prose text-foreground-muted text-pretty">{body}</p>
        {canConfirm && token ? (
          <UnsubscribeConfirm token={token} scope={link.kind === "all" ? "all" : "one"} />
        ) : (
          <Button asChild variant="outline">
            <Link href="/recherches">{t("manage")}</Link>
          </Button>
        )}
      </section>
    </Container>
  );
}
