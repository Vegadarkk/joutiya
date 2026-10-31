import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BadgeCheck, Coins, Gift, Rocket, Sparkles, Store, User } from "lucide-react";
import { Container } from "@/components/layout/container";
import { buttonVariants } from "@/components/ui/button";
import { launchOfferOpen } from "@/config/pricing";
import { Link } from "@/i18n/navigation";
import { localeParams, numbersLocale, pageLocale } from "@/i18n/params";
import { getPricing } from "@/lib/config/runtime";
import { alternates } from "@/lib/i18n/metadata";
import { PRICING_PATH, PRO_LANDING_PATH, PRO_SPACE_PATH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

const WALLET_PATH = "/porte-monnaie";

// Public price list (owner, 2026-10-30: the offers must be visible): what an individual and a
// Pro pay, read from the pricing config (Firestore config/pricing, cached) so the page never
// drifts from what checkout charges. Packs are in MAD VAT included; Pro plans and the pass are
// excluding VAT. Sales open at launch: the page says so while they are closed. ISR, one hour.
export const revalidate = 3600;

export function generateStaticParams() {
  return localeParams();
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Pricing" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: alternates(locale, PRICING_PATH) };
}

const mad = (minor: number) => Math.round(minor / 100);

function Card({ title, price, note, items, Icon, highlight }: { title: string; price: string; note?: string; items: string[]; Icon: typeof Store; highlight?: string }) {
  return (
    <article className={cn("relative flex flex-col gap-4 rounded-lg border bg-surface p-6", highlight ? "border-featured shadow-md" : "border-border")}>
      {highlight ? <span className="absolute -top-3 start-6 rounded-full bg-featured px-3 py-0.5 text-xs font-semibold text-featured-foreground">{highlight}</span> : null}
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-structure text-structure-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <p className="text-2xl font-semibold">{price}</p>
      {note ? <p className="-mt-3 text-sm text-foreground-muted">{note}</p> : null}
      <ul className="flex flex-col gap-2 text-sm">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <BadgeCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export default async function PricingPage({ params }: { params: Params }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const [t, n, pricing] = await Promise.all([
    getTranslations({ locale, namespace: "Pricing" }),
    getTranslations({ locale: numbersLocale(locale), namespace: "Pricing" }),
    getPricing(),
  ]);
  const offer = launchOfferOpen(pricing.launchOffer, new Date()) ? pricing.launchOffer : null;
  const { essentiel, business } = pricing.plans;
  const pass = pricing.passes[0] ?? null;
  const listings = (value: number | null) => (value === null ? t("pros.unlimitedListings") : `${n("count", { count: value })} ${t("pros.activeListings")}`);
  return (
    <Container className="flex flex-col gap-12 py-8 md:py-12">
      <section className="arch threshold flex flex-col gap-3 rounded-b-lg bg-structure px-6 pt-12 pb-8 text-center text-structure-foreground sm:px-10 sm:text-start">
        <p className="text-sm font-semibold tracking-wide text-gold-300 uppercase">{t("eyebrow")}</p>
        <h1 className="text-3xl font-semibold text-balance md:text-4xl">{t("title")}</h1>
        <p className="max-w-prose text-structure-foreground/85 text-pretty md:text-lg">{t("lead")}</p>
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="pricing-individuals">
        <h2 id="pricing-individuals" className="text-2xl font-semibold">{t("individuals.title")}</h2>
        <div className="grid gap-5 md:grid-cols-3">
          <Card
            Icon={User}
            title={t("individuals.free.title")}
            price={t("free")}
            items={[
              n("individuals.free.listings", { count: pricing.individual.activeListings ?? 0 }),
              n("individuals.free.photos", { count: pricing.individual.photosPerListing }),
              t("individuals.free.messaging"),
            ]}
          />
          <Card
            Icon={Rocket}
            title={t("individuals.options.title")}
            price={n("fromCredits", { count: pricing.options.bump.standard })}
            note={t("individuals.options.note")}
            items={[
              n("individuals.options.bump", { standard: pricing.options.bump.standard, premium: pricing.options.bump.premiumCat }),
              n("individuals.options.featured7", { standard: pricing.options.featured7.standard, premium: pricing.options.featured7.premiumCat }),
              n("individuals.options.featured30", { standard: pricing.options.featured30.standard, premium: pricing.options.featured30.premiumCat }),
            ]}
          />
          <Card
            Icon={Coins}
            title={t("individuals.packs.title")}
            price={n("fromMad", { amount: Math.min(...pricing.packs.filter((pack) => pack.currency === "MAD").map((pack) => mad(pack.priceMinor))) })}
            note={t("individuals.packs.note")}
            items={pricing.packs
              .filter((pack) => pack.currency === "MAD")
              .map((pack) => (pack.bonus > 0 ? n("individuals.packs.packBonus", { amount: mad(pack.priceMinor), credits: pack.paid, bonus: pack.bonus }) : n("individuals.packs.pack", { amount: mad(pack.priceMinor), credits: pack.paid })))}
          />
        </div>
        {/* Buying happens in the wallet, behind sign-in (owner, 2026-10-31). */}
        <div className="flex flex-wrap gap-3">
          <Link href={WALLET_PATH} prefetch={false} className={buttonVariants({ variant: "primary", size: "md" })}>
            {t("individuals.packs.cta")}
          </Link>
        </div>
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="pricing-pros">
        <h2 id="pricing-pros" className="text-2xl font-semibold">{t("pros.title")}</h2>
        {offer ? (
          <p className="flex items-start gap-2 rounded-lg bg-featured/15 px-4 py-3 text-sm">
            <Gift className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {n("pros.launchOffer", { days: offer.noticeDays })}
          </p>
        ) : null}
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {pass ? (
            <Card
              Icon={Store}
              title={t("pros.pass.title")}
              price={n("perDays", { amount: mad(pass.priceMinor), days: pass.days })}
              note={t("exclVat")}
              items={[t("pros.pass.noCommitment"), n("pros.credits", { count: pass.credits }), n("pros.listings", { count: pricing.pro[pass.plan].activeListings ?? 0 })]}
            />
          ) : null}
          <Card
            Icon={Store}
            title={t("pros.essentiel")}
            price={n("perMonth", { amount: mad(essentiel.priceMinor.monthly) })}
            note={n("perYear", { amount: mad(essentiel.priceMinor.yearly) })}
            items={[listings(pricing.pro.essentiel.activeListings), n("pros.credits", { count: essentiel.credits }), t("pros.storefront")]}
          />
          <Card
            Icon={Sparkles}
            highlight={t("pros.popular")}
            title={t("pros.business")}
            price={n("perMonth", { amount: mad(business.priceMinor.monthly) })}
            note={n("perYear", { amount: mad(business.priceMinor.yearly) })}
            items={[listings(pricing.pro.business.activeListings), n("pros.credits", { count: business.credits }), n("pros.featured", { count: business.featured }), t("pros.storefront")]}
          />
          <Card Icon={BadgeCheck} title={t("pros.premium")} price={t("pros.onQuote")} items={[listings(null), t("pros.premiumSupport"), t("pros.storefront")]} />
        </div>
        <p className="text-sm text-foreground-muted">{t("pros.payAtSeller")}</p>
        <div className="flex flex-wrap gap-3">
          <Link href={PRO_SPACE_PATH} prefetch={false} className={buttonVariants({ variant: "primary", size: "md" })}>
            {t("pros.cta")}
          </Link>
          <Link href={PRO_LANDING_PATH} prefetch={false} className={buttonVariants({ variant: "outline", size: "md" })}>
            {t("pros.more")}
          </Link>
        </div>
      </section>
      <p className="text-sm text-foreground-muted">{t("footnote")}</p>
    </Container>
  );
}
