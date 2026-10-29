"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, BadgeCheck, CircleCheck, CircleDashed, Gift, Hourglass, PhoneCall, ShieldCheck, Store } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { StatusPanel } from "@/components/auth/status-panel";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link, useRouter } from "@/i18n/navigation";
import { numbersLocale } from "@/i18n/params";
import { signOut, useSession } from "@/lib/auth/client";
import type { ProMeResponse, ProSelfView } from "@/lib/contracts/pro";
import { isolate } from "@/lib/i18n/bidi";
import { publishesAsPro, type ProState } from "@/lib/pro/lifecycle";
import { loadProMe } from "@/lib/pro/client";
import { paymentEligible } from "@/lib/pro/seller-payment-rules";
import { cn } from "@/lib/utils";
import { RentalSetup } from "@/components/rental/rental-setup";
import { AgencySettings } from "./agency-settings";
import { SectionsSettings } from "./sections-settings";
import { ProApplicationForm } from "./pro-application-form";

// /pro: the member's Pro area (phase 7 design §4). One request (GET /api/pro/me) decides the
// screen: the application (intro, eligibility, form), the pending review, a rejection to correct,
// or the shop's dashboard (plan, launch offer, quotas, sector, shortcuts). Payments stay closed until the
// sales gate: nothing here sells.

type View = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; me: ProMeResponse };

const PLANS = ["none", "essentiel", "business", "premium"] as const;

export function ProSpace() {
  const t = useTranslations("Pro");
  const apiMessage = useApiErrorMessage();
  const [view, setView] = useState<View>({ kind: "loading" });
  const started = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setView({ kind: "loading" });
    try {
      setView({ kind: "ready", me: await loadProMe() });
    } catch (error) {
      setView({ kind: "failed", error });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      {view.kind === "loading" ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-4">
          <Skeleton className="h-44 w-full rounded-lg" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : view.kind === "failed" ? (
        <FormMessage
          error={view.error}
          title={t("loadFailed")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              {t("retry")}
            </Button>
          }
        >
          {apiMessage(view.error)}
        </FormMessage>
      ) : (
        <ProScreen me={view.me} onReload={() => void load(true)} />
      )}
    </div>
  );
}

function ProScreen({ me, onReload }: { me: ProMeResponse; onReload: () => void }) {
  const shop = me.shop;
  if (!shop) return <Application me={me} previous={null} onReload={onReload} />;
  const lifecycle = shop.lifecycle as ProState;
  if (lifecycle === "pending_verification") return <Pending shop={shop} />;
  if (lifecycle === "rejected") return <Application me={me} previous={shop} onReload={onReload} />;
  return <Dashboard me={me} shop={shop} lifecycle={lifecycle} />;
}

function Application({ me, previous, onReload }: { me: ProMeResponse; previous: ProSelfView | null; onReload: () => void }) {
  const t = useTranslations("Pro");
  if (!me.signupOpen) return <ErrorBanner tone="info" title={t("closed")} />;
  const { emailVerified, phoneVerified, accountActive } = me.eligibility;
  const byCall = !phoneVerified && me.phoneVerification === "call";
  const eligible = accountActive && emailVerified && (phoneVerified || byCall);
  return (
    <div className="flex flex-col gap-10">
      {previous ? (
        <ErrorBanner tone="warning" title={t("rejected.title")}>
          {previous.rejectReason ? (
            <p dir="auto" className="whitespace-pre-line">
              {t("rejected.reason", { reason: isolate(previous.rejectReason) })}
            </p>
          ) : null}
          <p className="mt-1">{t("rejected.fix")}</p>
        </ErrorBanner>
      ) : (
        <Intro launchOffer={me.launchOffer} />
      )}
      {accountActive ? (
        <section className="flex flex-col gap-4" aria-labelledby="pro-eligibility">
          <h2 id="pro-eligibility" className="text-lg font-semibold">
            {t("eligibility.title")}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            <Requirement done={emailVerified} label={t("eligibility.email")} action={emailVerified ? null : <InlineLink href="/parametres">{t("eligibility.settings")}</InlineLink>} />
            {byCall ? (
              <li className="flex items-start gap-3 px-4 py-3.5">
                <PhoneCall className="mt-0.5 size-5 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
                <span className="text-sm text-pretty">{t("eligibility.phoneCall")}</span>
              </li>
            ) : (
              <Requirement done={phoneVerified} label={t("eligibility.phone")} action={phoneVerified ? null : <InlineLink href="/verifications">{t("eligibility.verifyPhone")}</InlineLink>} />
            )}
          </ul>
          {eligible ? <p className="text-sm text-foreground-muted">{t("eligibility.ready")}</p> : null}
        </section>
      ) : (
        <ErrorBanner tone="danger" title={t("eligibility.inactive")} />
      )}
      {eligible ? <ProApplicationForm previous={previous} needsPhone={byCall} onDone={onReload} /> : null}
    </div>
  );
}

/** The Pro door: the green of the structure, the shop's arch, the offer on its gold threshold. */
function Intro({ launchOffer }: { launchOffer: ProMeResponse["launchOffer"] }) {
  const t = useTranslations("Pro.intro");
  return (
    <section className="arch threshold flex flex-col gap-6 rounded-b-lg bg-structure px-6 pt-12 pb-8 text-structure-foreground sm:px-10">
      <span className="flex size-14 items-center justify-center self-center rounded-full bg-featured text-featured-foreground shadow-sm sm:self-start">
        <Store className="size-7" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-3 text-center sm:text-start">
        <h2 className="text-2xl font-semibold text-balance">{t("title")}</h2>
        <p className="max-w-prose text-structure-foreground/85 text-pretty">{t("lead")}</p>
      </div>
      <ul className="flex flex-col gap-3 text-sm">
        {launchOffer ? (
          <li className="flex items-start gap-3">
            <Gift className="mt-0.5 size-5 shrink-0 text-gold-300" aria-hidden="true" />
            <span className="text-pretty">{t("offer", { days: launchOffer.noticeDays })}</span>
          </li>
        ) : null}
        <li className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-gold-300" aria-hidden="true" />
          <span className="text-pretty">{t("how")}</span>
        </li>
      </ul>
    </section>
  );
}

function Requirement({ done, label, action }: { done: boolean; label: string; action: ReactNode }) {
  const Icon = done ? CircleCheck : CircleDashed;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3.5">
      <Icon className={cn("size-5 shrink-0", done ? "text-success" : "text-foreground-muted")} aria-hidden="true" />
      <span className={cn("flex-1 text-sm", done ? "text-foreground" : "font-medium")}>
        {label}
        <span className="sr-only">{done ? " ✓" : ""}</span>
      </span>
      {action}
    </li>
  );
}

function InlineLink({ href, children }: { href: "/parametres" | "/verifications"; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm font-medium text-link underline underline-offset-2">
      {children}
    </Link>
  );
}

function useDate() {
  const locale = useLocale() as Locale;
  return (iso: string) => new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "long", timeZone: "Africa/Casablanca" }).format(new Date(iso));
}

function Pending({ shop }: { shop: ProSelfView }) {
  const t = useTranslations("Pro.pending");
  const date = useDate();
  return (
    <StatusPanel icon={Hourglass} title={t("title")} autoFocus={false}>
      {t("body", { name: isolate(shop.name), date: shop.submittedAt ? date(shop.submittedAt) : "" })}
    </StatusPanel>
  );
}

function Dashboard({ me, shop, lifecycle }: { me: ProMeResponse; shop: ProSelfView; lifecycle: ProState }) {
  const t = useTranslations("Pro.dashboard");
  const locale = useLocale() as Locale;
  const date = useDate();
  const { session } = useSession();
  const router = useRouter();
  const city = cityBySlug(shop.citySlug);
  const plan = (PLANS as readonly string[]).includes(shop.plan) ? (shop.plan as (typeof PLANS)[number]) : "none";
  const suspended = lifecycle === "suspended";
  // The role is read from the session cookie: a shop verified since the last sign-in publishes as Pro only after a new one.
  const staleRole = publishesAsPro(lifecycle) && session !== null && session.role !== "pro";
  const canPublish = publishesAsPro(lifecycle) && plan !== "none" && !staleRole;

  async function signInAgain() {
    await signOut();
    router.push(`/connexion?next=${encodeURIComponent(`/${locale}/pro`)}`);
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="threshold flex flex-col gap-4 rounded-lg bg-structure px-6 pt-6 pb-7 text-structure-foreground sm:flex-row sm:items-center sm:gap-5">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-featured text-featured-foreground">
          <Store className="size-7" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 dir="auto" className="truncate text-2xl font-semibold">
            {shop.name}
          </h2>
          {city ? <p className="text-sm text-structure-foreground/80">{cityName(city, locale)}</p> : null}
        </div>
        {suspended ? (
          <Badge variant="danger" className="self-start px-3 py-1 text-sm sm:self-center">
            {t("suspended")}
          </Badge>
        ) : (
          <Badge variant="featured" className="self-start px-3 py-1 text-sm sm:self-center">
            <BadgeCheck className="size-4" aria-hidden="true" />
            {t("verified")}
          </Badge>
        )}
      </section>

      {staleRole ? (
        <ErrorBanner
          tone="info"
          title={t("signInAgain")}
          action={
            <Button type="button" variant="structure" size="sm" onClick={() => void signInAgain()}>
              {t("signIn")}
            </Button>
          }
        />
      ) : null}
      {suspended ? (
        <ErrorBanner tone="danger" title={t("suspended")}>
          {t("suspendedBody")}
        </ErrorBanner>
      ) : lifecycle === "grace" ? (
        <ErrorBanner tone="warning" title={t("grace_title")}>
          {t("grace")}
        </ErrorBanner>
      ) : lifecycle === "downgraded" ? (
        <ErrorBanner tone="info" title={t("downgraded")}>
          {t("noPlan")}
          {me.salesOpen ? null : <> {t("salesClosed")}</>}
        </ErrorBanner>
      ) : null}

      {suspended ? null : (
        <div className="grid gap-6 md:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5" aria-labelledby="pro-plan">
            <h2 id="pro-plan" className="text-sm font-medium text-foreground-muted">
              {t("plan")}
            </h2>
            <p className="text-2xl font-semibold">{t(`plans.${plan}`)}</p>
            {plan === "none" ? (
              <p className="text-sm text-foreground-muted text-pretty">{lifecycle === "downgraded" ? null : t("noPlan")}</p>
            ) : shop.launchOffer ? (
              <p className="flex items-start gap-2 text-sm text-pretty">
                <Gift className="mt-0.5 size-4 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
                <span>{shop.launchOffer.endsAt ? t("launchOfferEnds", { date: date(shop.launchOffer.endsAt) }) : t("launchOffer", { days: shop.launchOffer.noticeDays })}</span>
              </p>
            ) : null}
            <Link href="/pro/abonnement" className={cn("mt-auto inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
              {t("subscription")}
              <ArrowRight aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
            </Link>
          </section>
          <Quotas shop={shop} />
        </div>
      )}

      {canPublish && shop.sector === "car_rental" ? <RentalSetup shop={shop} /> : null}

      {suspended ? null : <AgencySettings shop={shop} />}
      {canPublish && shop.sector !== "car_rental" ? <SectionsSettings shop={shop} /> : null}

      <section className="flex flex-col gap-3" aria-labelledby="pro-shortcuts">
        <h2 id="pro-shortcuts" className="text-lg font-semibold">
          {t("shortcuts")}
        </h2>
        <div className="flex flex-wrap gap-3">
          {canPublish ? (
            <Button asChild>
              <Link href="/deposer">{t("newListing")}</Link>
            </Button>
          ) : null}
          {canPublish ? (
            <Button asChild variant="outline">
              <Link href="/pro/stock">{t("stockImport")}</Link>
            </Button>
          ) : null}
          {canPublish && shop.sector !== "real_estate" ? (
            <Button asChild variant="outline">
              <Link href="/pro/flotte">{t("fleet")}</Link>
            </Button>
          ) : null}
          {canPublish && shop.sector === "car_rental" ? (
            <Button asChild variant="outline">
              <Link href="/pro/location">{t("rentalAgency")}</Link>
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href="/mes-annonces">{t("myListings")}</Link>
          </Button>
          {shop.storefront && !suspended ? (
            <Button asChild variant="outline">
              <Link href={`/boutique/${shop.storefront}`}>{t("storefront")}</Link>
            </Button>
          ) : null}
          {paymentEligible(lifecycle, plan) ? (
            <Button asChild variant="outline">
              <Link href="/pro/paiement">{t("sellerPayment")}</Link>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Quotas({ shop }: { shop: ProSelfView }) {
  const t = useTranslations("Pro.dashboard");
  const limit = shop.quotas.activeListings;
  const used = limit ? Math.min(1, shop.activeListings / limit) : 0;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5" aria-labelledby="pro-quotas">
      <h2 id="pro-quotas" className="text-sm font-medium text-foreground-muted">
        {t("quotasTitle")}
      </h2>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">{t("active")}</span>
          <span className="text-sm tabular-nums">{limit === null ? t("activeUnlimited", { count: shop.activeListings }) : t("activeCount", { count: shop.activeListings, limit })}</span>
        </div>
        {limit === null ? null : (
          <div
            role="meter"
            aria-label={t("active")}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(shop.activeListings, limit)}
            className="h-2 overflow-hidden rounded-full bg-surface-muted"
          >
            <span className={cn("block h-full rounded-full transition-[width] duration-300 ease-door", used >= 1 ? "bg-warning" : "bg-structure dark:bg-gold-300")} style={{ width: `${Math.round(used * 100)}%` }} />
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm text-foreground-muted">
        <li>{shop.quotas.listingsPerDay === null ? t("perDayUnlimited") : t("perDay", { count: shop.quotas.listingsPerDay })}</li>
        <li>{t("photos", { count: shop.quotas.photosPerListing })}</li>
      </ul>
    </section>
  );
}
