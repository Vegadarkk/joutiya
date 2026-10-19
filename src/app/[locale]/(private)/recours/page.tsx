import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DecisionCard } from "@/components/appeals/decision-card";
import { DecisionsView } from "@/components/appeals/decisions-view";
import { FrenchOnlyNotice } from "@/components/auth/french-only-notice";
import { DoorMark } from "@/components/feedback/door-mark";
import { Container } from "@/components/layout/container";
import { Button } from "@/components/ui/button";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { currentMember } from "@/lib/auth/current-user";
import { appealLinkView } from "@/lib/decisions";
import { APPEAL_TOKEN_PARAM, type AppealableDecision } from "@/lib/decisions/contracts";
import { HttpError } from "@/lib/http/errors";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// /recours (art. 20 DSA, design D16), two readers. Signed in, without a token: the account's
// decisions and their appeals. With ?jeton=: the decision the signed link of a decision or outcome
// mail names, readable signed out (banned accounts, notifiers without an account); the token is
// checked here, as GET /api/appeals/link would. Private dynamic page (PRIVATE_SEGMENTS).

type Search = Promise<Record<string, string | string[] | undefined>>;

function tokenOf(search: Record<string, string | string[] | undefined>): string | undefined {
  const raw = search[APPEAL_TOKEN_PARAM];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export async function generateMetadata({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Search }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Appeals" });
  return { title: tokenOf(await searchParams) ? t("link.title") : t("page.title") };
}

type LinkResult = { kind: "ok"; decision: AppealableDecision } | { kind: "invalid" | "expired" | "limited" | "unavailable" };

async function readLink(token: string): Promise<LinkResult> {
  try {
    await enforceLimit("appeal.link.ip", requestIdentity(await headers()).ipBucket);
    return { kind: "ok", decision: await appealLinkView(token) };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 404 || error.status === 400) return { kind: "invalid" };
    if (error.code === "appeal_closed") return { kind: "expired" };
    if (error.status === 429) return { kind: "limited" };
    return { kind: "unavailable" };
  }
}

export default async function AppealsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Search }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Appeals" });
  const token = tokenOf(await searchParams);
  // Tarifit: account pages and their mail links are French until a native review (FrenchOnlyNotice).
  const lang = locale === "rif" ? "fr" : undefined;

  if (token) {
    const link = await readLink(token);
    if (link.kind !== "ok") {
      const title = link.kind === "unavailable" ? t("link.title") : t(`link.${link.kind}Title`);
      const body = link.kind === "unavailable" ? t("errors.unavailable") : t(`link.${link.kind}Body`);
      return (
        <Container lang={lang} className="max-w-xl py-12 lg:py-16">
          <FrenchOnlyNotice className="mb-8" />
          <section data-testid="appeal-link-state" data-kind={link.kind} className="flex flex-col items-center gap-5 rounded-lg border border-border bg-surface px-6 py-10 text-center shadow-sm shadow-bab-950/5 sm:px-10">
            <DoorMark className="w-16" />
            <h1 className="text-2xl font-semibold text-balance">{title}</h1>
            <p className="max-w-prose text-foreground-muted text-pretty">{body}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild variant="outline">
                <Link href="/">{t("link.home")}</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/recours">{t("link.account")}</Link>
              </Button>
            </div>
          </section>
        </Container>
      );
    }
    return (
      <Container lang={lang} className="max-w-2xl py-10 lg:py-14">
        <FrenchOnlyNotice className="mb-8" />
        <header className="mb-8 flex flex-col gap-3">
          <h1 className="text-3xl font-semibold text-balance">{t("link.title")}</h1>
          <p className="max-w-prose text-foreground-muted text-pretty">{t("link.intro")}</p>
        </header>
        <DecisionCard decision={link.decision} mode={{ kind: "link", token }} formOpen />
        <p className="mt-8 text-xs text-foreground-muted text-pretty">{t("host")}</p>
      </Container>
    );
  }

  if (!(await currentMember())) {
    // `x-pathname` (path + query) is set by the proxy for private pages.
    const next = (await headers()).get("x-pathname");
    redirect({ href: next ? { pathname: "/connexion", query: { next } } : "/connexion", locale });
  }
  return (
    <Container lang={lang} className="max-w-2xl py-10 lg:py-14">
      <FrenchOnlyNotice className="mb-8" />
      <header className="mb-8 flex flex-col gap-3">
        <h1 className="text-3xl font-semibold text-balance">{t("page.title")}</h1>
        <p className="max-w-prose text-foreground-muted text-pretty">{t("page.intro")}</p>
      </header>
      <DecisionsView />
      <p className="mt-8 text-xs text-foreground-muted text-pretty">{t("host")}</p>
    </Container>
  );
}
