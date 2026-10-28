"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarClock, Check, Gift, ReceiptText } from "lucide-react";
import { useLocale } from "next-intl";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import type { PaidPlanId, PlanInterval } from "@/config/pricing";
import type { Locale } from "@/config/site";
import { getPathname, Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { numbersLocale } from "@/i18n/params";
import { isApiError } from "@/lib/auth/client";
import type { PlanOffer, SubscriptionResponse } from "@/lib/contracts/payments";
import { checkoutPlan, loadSubscription, openBillingPortal } from "@/lib/payments/client";
import { cn } from "@/lib/utils";
import { PASS_BEFORE_KEY, PassOffer, passBlock } from "./pass-offer";

// /pro/abonnement (phase 7 design §7): the shop's plan and the two offers, drawn as the doors of
// the brand. A shop without a running plan picks an offer and a payment rhythm, accepts the terms
// and pays on Stripe's page; a running plan is changed, paid or cancelled in Stripe's portal. Back
// from Stripe (`?abonnement=ok`) the page reloads until RevenueCat's event has activated the plan.
// Below the plans, the Pass Boutique (one payment, no renewal; `?pass=ok` on its return).

type State = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; data: SubscriptionResponse };

/** Codes the page explains in its own words (Subscription.errors). */
const PLAN_ERRORS = ["sales_closed", "already_subscribed", "pro_not_verified", "no_billing_customer", "billing_owner_only", "unavailable"] as const;
/** Seconds after the return from Stripe at which the plan is read again. */
const AFTER_PAYMENT_RELOADS = [3, 6, 10, 15, 25, 40, 60, 90, 120];
/** Lifecycle states of a shop that may take a plan (src/lib/payments/plans.ts). */
const SUBSCRIBABLE: ReadonlySet<string> = new Set(["verified", "active", "grace", "downgraded"]);
const INTERVALS: readonly PlanInterval[] = ["monthly", "yearly"];

/** Price in major units, for ICU's number format (up to 2 decimals). */
const major = (minor: number) => Math.round(minor) / 100;
const running = (data: SubscriptionResponse) => data.subscription !== null && data.subscription.status !== "expired";
/** Lifecycle states of a shop that may see the Pass Boutique (src/lib/payments/pass.ts). */
const PASS_STATES: ReadonlySet<string> = new Set(["verified", "active", "downgraded"]);

function passBefore(): string | null {
  try {
    return sessionStorage.getItem(PASS_BEFORE_KEY);
  } catch {
    return null;
  }
}

export function SubscriptionView() {
  const t = useNumbersTranslations("Subscription");
  const apiMessage = useApiErrorMessage();
  const locale = useLocale() as Locale;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [interval, setCadence] = useState<PlanInterval>("monthly");
  const [choice, setChoice] = useState<PaidPlanId | null>(null);
  const [terms, setTerms] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<"checkout" | "portal" | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  // Back from Stripe: whether the plan (or the pass) has been activated since.
  const activated = useRef(false);
  const search = useSearchParams();
  const paidPlan = search.get("abonnement") === "ok";
  const paidPass = search.get("pass") === "ok";
  const [waited, setWaited] = useState(false);

  const date = useCallback((iso: string) => new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "long", timeZone: "Africa/Casablanca" }).format(new Date(iso)), [locale]);

  // State changes only once the answer is in (the first render is already "loading").
  const fetchPlan = useCallback(async () => {
    try {
      const data = await loadSubscription();
      if (paidPass ? data.planSource === "pass" && data.passEndsAt !== null && data.passEndsAt !== passBefore() : running(data)) activated.current = true;
      setState({ kind: "ready", data });
    } catch (error) {
      setState({ kind: "failed", error });
    }
  }, [paidPass]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchPlan();
  }, [fetchPlan]);

  const paid = paidPlan || paidPass;
  useEffect(() => {
    if (!paid) return;
    const last = AFTER_PAYMENT_RELOADS.at(-1)!;
    const timers = AFTER_PAYMENT_RELOADS.map((seconds) =>
      setTimeout(() => {
        if (!activated.current) void fetchPlan();
        if (seconds === last) setWaited(true);
      }, seconds * 1_000),
    );
    return () => timers.forEach(clearTimeout);
  }, [paid, fetchPlan]);

  function reload() {
    setState({ kind: "loading" });
    setChoice(null);
    void fetchPlan();
  }

  const messageOf = (error: unknown) => {
    const code = PLAN_ERRORS.find((candidate) => isApiError(error, candidate));
    return code ? t(`errors.${code}`) : apiMessage(error);
  };

  if (state.kind === "loading") {
    return (
      <div aria-busy="true" aria-label={t("loading")} className="flex flex-col gap-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="arch h-96" />
          <Skeleton className="arch h-96" />
        </div>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <ErrorBanner
        title={t("failed")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t("retry")}
          </Button>
        }
      >
        {apiMessage(state.error)}
      </ErrorBanner>
    );
  }

  const { data } = state;
  const live = running(data);
  // A Stripe payment still due after the grace: the plan is withdrawn while Stripe keeps the subscription open.
  const unpaid = live && data.lifecycle === "downgraded";
  const suspended = data.lifecycle === "suspended";
  const canSubscribe = data.salesOpen && data.available && !live && SUBSCRIBABLE.has(data.lifecycle);
  const selected = canSubscribe ? data.plans.find((plan) => plan.id === choice && plan.available) : undefined;
  const problems = attempted ? { choice: !selected, terms: !terms } : { choice: false, terms: false };
  // The plan the shop has now: a running subscription's, or Essentiel during the launch offer.
  // The shop's state wins over the doc's: a grace opened from Stripe, a plan withdrawn after it.
  const shownStatus = unpaid ? "unpaid" : data.lifecycle === "grace" && data.subscription?.status === "active" ? "grace" : (data.subscription?.status ?? "expired");
  const current = live && !unpaid ? data.subscription!.plan : data.planSource === "launch_offer" ? data.plan : null;
  const onPass = data.planSource === "pass" && data.passEndsAt !== null && data.lifecycle === "active";
  const passActive = onPass && (!paidPass || data.passEndsAt !== passBefore());
  const showPasses = PASS_STATES.has(data.lifecycle) && data.passes.length > 0;

  async function subscribe() {
    setAttempted(true);
    if (!selected || !terms) return;
    setPending("checkout");
    setFailure(undefined);
    try {
      const { url } = await checkoutPlan(selected.id, interval, locale);
      // Stripe's page; the button stays busy until the browser leaves.
      window.location.assign(url);
    } catch (error) {
      setPending(null);
      setFailure(error);
      if (isApiError(error, "sales_closed", "already_subscribed", "pro_not_verified")) reload();
    }
  }

  async function manage() {
    setPending("portal");
    setFailure(undefined);
    try {
      const { url } = await openBillingPortal(locale);
      window.location.assign(url);
    } catch (error) {
      setPending(null);
      setFailure(error);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Link href="/pro" className={cn("inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
          <ArrowLeft aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
          {t("back")}
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        </div>
      </header>

      {paidPass ? (
        <ErrorBanner tone="info" title={t("success.title")}>
          {passActive ? t("pass.success.done", { date: date(data.passEndsAt!) }) : waited ? t("success.slow") : t("pass.success.pending")}
        </ErrorBanner>
      ) : paid ? (
        <ErrorBanner tone="info" title={t("success.title")}>
          {live ? t("success.done") : waited ? t("success.slow") : t("success.pending")}
        </ErrorBanner>
      ) : null}
      {suspended ? (
        <ErrorBanner tone="danger" title={t("suspended")} />
      ) : data.lifecycle === "grace" && data.graceUntil ? (
        <ErrorBanner tone="warning" title={t("grace.title")}>
          {t("grace.body", { date: date(data.graceUntil) })}
        </ErrorBanner>
      ) : unpaid ? (
        <ErrorBanner tone="warning" title={t("unpaid.title")}>
          {t("unpaid.body")}
        </ErrorBanner>
      ) : data.lifecycle === "downgraded" ? (
        <ErrorBanner tone="info" title={t("downgraded.title")}>
          {t("downgraded.body")}
        </ErrorBanner>
      ) : null}
      {!data.salesOpen && !live ? <ErrorBanner tone="info" title={t(data.planSource === "launch_offer" ? "closed" : "closedSoon")} /> : null}
      {data.salesOpen && !data.available ? <ErrorBanner tone="warning" title={t("unavailable")} /> : null}

      <section aria-labelledby="plan-current" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 id="plan-current" className="text-sm font-medium text-foreground-muted">
            {t("current.title")}
          </h2>
          {live ? (
            <>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-2xl font-semibold">{data.subscription!.plan === "business" ? "Business" : "Essentiel"}</span>
                <Badge variant={shownStatus === "active" ? "success" : shownStatus === "cancelled" ? "neutral" : "warning"}>{t(`status.${shownStatus}`)}</Badge>
              </p>
              <p className="flex flex-col text-sm text-foreground-muted">
                <span>{t(`current.${data.subscription!.interval}`)}</span>
                {data.subscription!.periodEnd && !unpaid ? <span>{data.subscription!.willRenew ? t("current.renews", { date: date(data.subscription!.periodEnd) }) : t("current.ends", { date: date(data.subscription!.periodEnd) })}</span> : null}
              </p>
            </>
          ) : onPass ? (
            <>
              <p className="flex items-center gap-2 text-2xl font-semibold">
                <CalendarClock className="size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
                {t("pass.current")}
              </p>
              <p className="text-sm text-foreground-muted text-pretty">{t("pass.currentEnds", { date: date(data.passEndsAt!) })}</p>
            </>
          ) : data.planSource === "launch_offer" ? (
            <>
              <p className="flex items-center gap-2 text-2xl font-semibold">
                <Gift className="size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
                {t("current.launchOffer")}
              </p>
              <p className="text-sm text-foreground-muted text-pretty">{data.launchOfferEndsAt ? t("current.launchOfferEnds", { date: date(data.launchOfferEndsAt) }) : t("current.launchOfferBody", { days: data.launchOfferNoticeDays })}</p>
            </>
          ) : (
            <p className="text-2xl font-semibold">{t("current.none")}</p>
          )}
        </div>
        {data.subscription && data.available && !suspended ? (
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <Button type="button" variant={live ? "structure" : "outline"} loading={pending === "portal"} disabled={pending === "checkout"} onClick={() => void manage()}>
              {t("current.manage")}
            </Button>
            <Link href="/pro/factures" className={cn("inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-link", textLinkClassName)}>
              <ReceiptText aria-hidden="true" className="size-4 shrink-0" />
              {t("current.invoices")}
            </Link>
          </div>
        ) : null}
      </section>
      {live && !suspended ? <p className="-mt-5 text-sm text-foreground-muted text-pretty">{t("current.manageHint")}</p> : null}

      <form
        noValidate
        aria-labelledby="plan-offers"
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          void subscribe();
        }}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="plan-offers" className="text-lg font-semibold">
            {t("offers")}
          </h2>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("interval.legend")}</legend>
            <div className="inline-flex w-fit rounded-md border border-border bg-surface-muted p-1">
              {INTERVALS.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                    interval === value ? "bg-surface text-foreground shadow-xs" : "text-foreground-muted hover:text-foreground",
                  )}
                >
                  <input type="radio" name="plan-interval" value={value} checked={interval === value} onChange={() => setCadence(value)} className="sr-only" />
                  {t(`interval.${value}`)}
                  {value === "yearly" ? <span className="rounded-sm bg-featured px-1.5 py-0.5 text-xs text-featured-foreground">{t("interval.yearlyHint")}</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset aria-invalid={problems.choice ? true : undefined} className="flex flex-col gap-3">
          <legend className="sr-only">{t("offers")}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.plans.map((plan) => (
              <PlanDoor key={plan.id} plan={plan} interval={interval} current={plan.id === current} selectable={canSubscribe && plan.available} selected={plan.id === selected?.id} onSelect={() => setChoice(plan.id)} />
            ))}
          </div>
          {problems.choice ? <InlineError>{t("choose")}</InlineError> : null}
        </fieldset>

        {canSubscribe ? (
          <>
            <section aria-labelledby="plan-notes" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-5">
              <h2 id="plan-notes" className="font-semibold">
                {t("notesTitle")}
              </h2>
              <ul className="flex list-disc flex-col gap-2 ps-5 text-sm text-pretty marker:text-foreground-muted">
                <li>{t("notes.stripe")}</li>
                <li>{t("notes.renewal")}</li>
                <li>{t("notes.credits")}</li>
                <li>{t("notes.invoices")}</li>
              </ul>
            </section>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-start gap-3 text-sm text-pretty">
                <input type="checkbox" checked={terms} aria-invalid={problems.terms ? true : undefined} onChange={(event) => setTerms(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
                <span>
                  {t("consent.terms")}{" "}
                  <a href={getPathname({ href: "/legal/cgv", locale })} target="_blank" rel="noopener noreferrer" className={cn("font-medium", textLinkClassName)}>
                    {t("consent.termsLink")}
                  </a>{" "}
                  {t("consent.renewal")}
                </span>
              </label>
              {problems.terms ? <InlineError>{t("consent.required")}</InlineError> : null}
            </div>
          </>
        ) : null}

        {failure !== undefined ? <FormMessage error={failure} title={messageOf(failure)} /> : null}

        {canSubscribe ? (
          <div className="flex justify-end border-t border-border pt-6">
            <Button type="submit" variant="structure" loading={pending === "checkout"} disabled={pending === "portal"} className="w-full sm:w-auto">
              {selected ? t(`submit.${interval}`, { amount: major(selected.priceMinor[interval]) }) : t("submitIdle")}
            </Button>
          </div>
        ) : null}
      </form>

      {showPasses
        ? data.passes.map((offer) => <PassOffer key={offer.id} data={data} offer={offer} block={passBlock(data, offer, live)} locale={locale} date={date} onReload={reload} />)
        : null}
    </div>
  );
}

/**
 * One offer, drawn as a door (the arch of the logo): Business in the frame's green, Essentiel in
 * cream. Choosing one lays the gold threshold under it.
 */
function PlanDoor({ plan, interval, current, selectable, selected, onSelect }: { plan: PlanOffer; interval: PlanInterval; current: boolean; selectable: boolean; selected: boolean; onSelect: () => void }) {
  const t = useNumbersTranslations("Subscription");
  const business = plan.id === "business";
  const Root = selectable ? "label" : "div";
  return (
    <Root
      className={cn(
        "arch relative flex flex-col gap-5 border px-6 pt-10 pb-6 transition-[box-shadow,border-color] duration-200 ease-door",
        business ? "border-structure bg-structure text-structure-foreground dark:border-featured/45" : "border-border bg-surface",
        selectable && "cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        selectable && !selected && (business ? "hover:border-bab-600" : "hover:border-border-strong"),
        // The gold threshold under the chosen door.
        selected && "border-featured shadow-[inset_0_-6px_0_var(--featured),0_0_0_1px_var(--featured)]",
      )}
    >
      {selectable ? <input type="radio" name="plan" value={plan.id} checked={selected} onChange={onSelect} className="sr-only" /> : null}
      {current ? (
        <span className={cn("absolute inset-x-0 top-3 mx-auto w-fit rounded-sm px-2 py-0.5 text-xs font-medium", business ? "bg-featured text-featured-foreground" : "bg-structure text-structure-foreground")}>{t("yours")}</span>
      ) : null}
      <span className="flex flex-col items-center gap-2 text-center">
        <span className="text-xl font-semibold">{business ? "Business" : "Essentiel"}</span>
        <span className="text-sm leading-tight">
          {t.rich(`price.${interval}`, { amount: major(plan.priceMinor[interval]), n: (chunks) => <span className="block pb-1 text-4xl font-semibold tracking-tight tabular-nums">{chunks}</span> })}
        </span>
        {interval === "yearly" ? (
          <span className={cn("text-xs tabular-nums", business ? "text-structure-foreground/75" : "text-foreground-muted")}>{t("perMonth", { amount: Math.round(plan.priceMinor.yearly / 12) / 100 })}</span>
        ) : null}
      </span>
      <ul className={cn("flex flex-col gap-2.5 border-t pt-5 text-sm", business ? "border-structure-foreground/20" : "border-border")}>
        <Feature business={business}>{plan.activeListings === null ? t("features.unlimited") : t("features.listings", { count: plan.activeListings })}</Feature>
        <Feature business={business} off={plan.credits === 0}>
          {plan.credits === 0 ? t("features.noCredits") : t("features.credits", { count: plan.credits })}
        </Feature>
        <Feature business={business} off={plan.featured === 0}>
          {plan.featured === 0 ? t("features.noFeatured") : t("features.featured", { count: plan.featured })}
        </Feature>
        <Feature business={business}>{t("features.storefront")}</Feature>
      </ul>
    </Root>
  );
}

function Feature({ business, off = false, children }: { business: boolean; off?: boolean; children: ReactNode }) {
  return (
    <li className={cn("flex items-start gap-2.5 text-pretty", off && (business ? "text-structure-foreground/60" : "text-foreground-muted"))}>
      <Check aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", off ? "opacity-0" : business ? "text-gold-300" : "text-structure dark:text-gold-300")} />
      <span>{children}</span>
    </li>
  );
}
