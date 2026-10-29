import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Building2, CalendarDays, CarFront, CircleCheck, FileSpreadsheet, Gift, House, KeyRound, MessagesSquare, ShieldCheck, Store } from "lucide-react";
import { Container } from "@/components/layout/container";
import { buttonVariants } from "@/components/ui/button";
import { quietLinkClassName } from "@/components/ui/text-link";
import { launchOfferOpen } from "@/config/pricing";
import { Link } from "@/i18n/navigation";
import { localeParams, numbersLocale, pageLocale } from "@/i18n/params";
import { getPricing } from "@/lib/config/runtime";
import { alternates } from "@/lib/i18n/metadata";
import { PRO_LANDING_PATH, PRO_SPACE_PATH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

// The public page of the Pro offer (owner's choice B of 29 Oct 2026, UX audit): what a shop, a
// dealer or an agency gets, the launch offer and the steps, for visitors and members who cannot
// see the Pro space (/pro asks for a session). Its "Créer ma boutique" leads to /pro: the account
// guard sends a visitor to the sign-in page and brings them back. ISR, one hour: the launch offer
// and the quotas come from the pricing config (Firestore config/pricing, cached), never a price
// while the sales are closed.
export const revalidate = 3600;

export function generateStaticParams() {
  return localeParams();
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "ProLanding" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: alternates(locale, PRO_LANDING_PATH) };
}

const SECTORS = [
  { id: "shop", Icon: Store },
  { id: "dealer", Icon: CarFront },
  { id: "real_estate", Icon: Building2 },
  { id: "car_rental", Icon: KeyRound },
  { id: "holiday_rental", Icon: House },
] as const;

const INCLUDED = [
  { id: "storefront", Icon: Store },
  { id: "listings", Icon: CircleCheck },
  { id: "messaging", Icon: MessagesSquare },
  { id: "stock", Icon: FileSpreadsheet },
  { id: "planning", Icon: CalendarDays },
] as const;

const STEPS = ["account", "request", "review"] as const;

export default async function ProLandingPage({ params }: { params: Params }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const [t, count, pricing] = await Promise.all([
    getTranslations({ locale, namespace: "ProLanding" }),
    // Prints numbers: Tarifit pages format them as French (no Intl data for "rif").
    getTranslations({ locale: numbersLocale(locale), namespace: "ProLanding" }),
    getPricing(),
  ]);
  const offer = launchOfferOpen(pricing.launchOffer, new Date()) ? pricing.launchOffer : null;
  const pass = pricing.passes[0] ?? null;
  const essentiel = pricing.pro.essentiel.activeListings;
  return (
    <Container className="flex flex-col gap-12 py-8 md:py-12">
      <section className="arch threshold flex flex-col gap-6 rounded-b-lg bg-structure px-6 pt-12 pb-8 text-structure-foreground sm:px-10 md:gap-8">
        <span className="flex size-14 items-center justify-center self-center rounded-full bg-featured text-featured-foreground shadow-sm sm:self-start">
          <Store className="size-7" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-3 text-center sm:text-start">
          <p className="text-sm font-semibold tracking-wide text-gold-300 uppercase">{t("eyebrow")}</p>
          <h1 className="text-3xl font-semibold text-balance md:text-4xl">{t("title")}</h1>
          <p className="max-w-prose text-structure-foreground/85 text-pretty md:text-lg">{t("lead")}</p>
        </div>
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
          <Link href={PRO_SPACE_PATH} prefetch={false} className={cn(buttonVariants({ variant: "primary", size: "lg" }), "w-full sm:w-auto")}>
            <Store aria-hidden="true" />
            {t("cta")}
          </Link>
          <Link href={PRO_SPACE_PATH} prefetch={false} className={cn(quietLinkClassName, "text-sm font-medium text-structure-foreground/85 underline underline-offset-4 hover:text-structure-foreground")}>
            {t("already")}
          </Link>
        </div>
      </section>

      <section aria-labelledby="pro-sectors" className="flex flex-col gap-5">
        <h2 id="pro-sectors" className="text-2xl font-semibold text-balance">
          {t("sectorsTitle")}
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SECTORS.map(({ id, Icon }) => (
            <li key={id} className="flex gap-4 rounded-lg border border-border bg-surface p-5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-1">
                <h3 className="font-semibold">{t(`sectors.${id}.title`)}</h3>
                <p className="text-sm text-foreground-muted text-pretty">{t(`sectors.${id}.body`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pro-included" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-5">
          <h2 id="pro-included" className="text-2xl font-semibold text-balance">
            {t("includedTitle")}
          </h2>
          <ul className="flex flex-col gap-3">
            {INCLUDED.map(({ id, Icon }) => (
              <li key={id} className="flex items-start gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-structure dark:text-bab-200" aria-hidden="true" />
                <span className="text-pretty">{id === "listings" ? count("included.listings", { count: essentiel ?? 0 }) : t(`included.${id}`)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4 self-start rounded-lg bg-surface-brand p-5">
          {offer ? (
            <p className="flex items-start gap-3 text-sm text-pretty">
              <Gift className="mt-0.5 size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
              <span>{count("offer", { days: offer.noticeDays })}</span>
            </p>
          ) : null}
          {pass ? (
            <p className="flex items-start gap-3 text-sm text-pretty">
              <CalendarDays className="mt-0.5 size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
              <span>{count("pass", { days: pass.days })}</span>
            </p>
          ) : null}
          <p className="flex items-start gap-3 text-sm text-pretty">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
            <span>
              {t.rich("legal", {
                link: (chunks) => (
                  <Link href="/demarches/pro-cooperative" prefetch={false} className={cn(quietLinkClassName, "font-medium text-link underline underline-offset-2")}>
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          </p>
        </div>
      </section>

      <section aria-labelledby="pro-steps" className="flex flex-col gap-5">
        <h2 id="pro-steps" className="text-2xl font-semibold text-balance">
          {t("stepsTitle")}
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step} className="flex gap-4 rounded-lg border border-border bg-surface p-5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-structure text-sm font-semibold text-structure-foreground tabular-nums" aria-hidden="true">
                {index + 1}
              </span>
              <p className="text-sm text-pretty">{t(`steps.${step}`)}</p>
            </li>
          ))}
        </ol>
        <div>
          <Link href={PRO_SPACE_PATH} prefetch={false} className={buttonVariants({ variant: "structure", size: "md" })}>
            <Store aria-hidden="true" />
            {t("cta")}
          </Link>
        </div>
      </section>
    </Container>
  );
}
