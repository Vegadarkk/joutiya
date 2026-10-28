"use client";

import { useState } from "react";
import { CalendarClock, Check } from "lucide-react";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { textLinkClassName } from "@/components/ui/text-link";
import type { Locale } from "@/config/site";
import { getPathname } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { isApiError } from "@/lib/auth/client";
import type { PassOffer as Offer, SubscriptionResponse } from "@/lib/contracts/payments";
import { checkoutPass } from "@/lib/payments/client";
import { cn } from "@/lib/utils";

// The Pass Boutique on /pro/abonnement (owner decision 2026-10-28): one payment for `days` of the
// plan, no renewal. Drawn as a ticket beside the doors of the plans: dashed edge, the gold of the
// brand on the price. The shop's owner accepts the terms and pays on Stripe's page; back from it
// (`?pass=<end seen before, ms>`) the plan page reloads until the webhook has moved the end of the pass.

/** Codes the section explains in its own words (Subscription.errors). */
const PASS_ERRORS = ["sales_closed", "already_subscribed", "pro_not_verified", "pass_max_ahead", "pass_other_plan", "launch_offer_running", "billing_owner_only", "unavailable"] as const;

const major = (minor: number) => Math.round(minor) / 100;

export type PassBlock = "subscribed" | "launchOffer" | "otherPlan" | "maxAhead" | "unavailable" | null;

/** Why the shop cannot buy `offer` now, or null (shown as a sentence while sales are open, the button hidden). */
export function passBlock(data: SubscriptionResponse, offer: Offer, live: boolean): PassBlock {
  if (live || (data.lifecycle === "active" && data.planSource === "subscription")) return "subscribed";
  if (data.launchOfferOpen) return "launchOffer";
  if (!data.salesOpen || !data.available || !offer.available) return "unavailable";
  if (offer.otherPlan) return "otherPlan";
  if (!offer.withinLimit) return "maxAhead";
  return null;
}

export function PassOffer({ data, offer, block, locale, date, onReload }: { data: SubscriptionResponse; offer: Offer; block: PassBlock; locale: Locale; date: (iso: string) => string; onReload: () => void }) {
  const t = useNumbersTranslations("Subscription");
  const apiMessage = useApiErrorMessage();
  const [terms, setTerms] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const extending = data.planSource === "pass" && data.passEndsAt !== null;
  const buyable = block === null;
  const missingTerms = attempted && !terms;

  async function buy() {
    setAttempted(true);
    if (!terms) return;
    setPending(true);
    setFailure(undefined);
    try {
      const { url } = await checkoutPass(offer.id, locale);
      window.location.assign(url);
    } catch (error) {
      setPending(false);
      setFailure(error);
      if (isApiError(error, "sales_closed", "already_subscribed", "pro_not_verified", "pass_max_ahead", "pass_other_plan", "launch_offer_running")) onReload();
    }
  }

  const messageOf = (error: unknown) => {
    const code = PASS_ERRORS.find((candidate) => isApiError(error, candidate));
    return code ? t(`errors.${code}`) : apiMessage(error);
  };

  return (
    <section aria-labelledby={`pass-${offer.id}`} className="relative flex flex-col gap-6 rounded-lg border-2 border-dashed border-featured/70 bg-surface p-6 sm:p-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 id={`pass-${offer.id}`} className="flex items-center gap-2 text-lg font-semibold">
            <CalendarClock aria-hidden="true" className="size-5 shrink-0 text-gold-500 dark:text-gold-300" />
            {t("pass.title")}
          </h2>
          <p className="max-w-prose text-sm text-foreground-muted text-pretty">{t("pass.lead", { days: offer.days })}</p>
        </div>
        <p className="shrink-0 text-sm leading-tight sm:text-end">
          {t.rich("pass.price", { amount: major(offer.priceMinor), days: offer.days, n: (chunks) => <span className="block pb-1 text-4xl font-semibold tracking-tight text-foreground tabular-nums">{chunks}</span> })}
        </p>
      </div>

      <ul className="grid gap-2.5 border-t border-border pt-5 text-sm sm:grid-cols-2">
        {[
          offer.activeListings === null ? t("features.unlimited") : t("pass.features.listings", { count: offer.activeListings }),
          ...(offer.credits > 0 ? [t("pass.features.credits", { count: offer.credits })] : []),
          t("pass.features.storefront"),
          t("pass.features.noRenewal"),
        ].map((line) => (
          <li key={line} className="flex items-start gap-2.5 text-pretty">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-structure dark:text-gold-300" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {extending && buyable ? <p className="text-sm text-foreground-muted text-pretty">{t("pass.extendHint", { days: offer.days, date: date(data.passEndsAt!) })}</p> : null}

      {buyable ? (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void buy();
          }}
        >
          <ul className="flex list-disc flex-col gap-2 rounded-md bg-surface-muted p-4 ps-9 text-sm text-pretty marker:text-foreground-muted">
            <li>{t("pass.notes.once")}</li>
            <li>{t("pass.notes.credits")}</li>
            <li>{t("pass.notes.end")}</li>
            <li>{t("pass.notes.subscribe")}</li>
          </ul>
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-start gap-3 text-sm text-pretty">
              <input type="checkbox" checked={terms} aria-invalid={missingTerms ? true : undefined} onChange={(event) => setTerms(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
              <span>
                {t("pass.consent.terms")}{" "}
                <a href={getPathname({ href: "/legal/cgv", locale })} target="_blank" rel="noopener noreferrer" className={cn("font-medium", textLinkClassName)}>
                  {t("pass.consent.termsLink")}
                </a>{" "}
                {t("pass.consent.once")}
              </span>
            </label>
            {missingTerms ? <InlineError>{t("consent.required")}</InlineError> : null}
          </div>
          {failure !== undefined ? <FormMessage error={failure} title={messageOf(failure)} /> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="structure" loading={pending} className="w-full sm:w-auto">
              {extending ? t("pass.submitExtend", { days: offer.days, amount: major(offer.priceMinor) }) : t("pass.submit", { amount: major(offer.priceMinor) })}
            </Button>
          </div>
        </form>
      ) : block && data.salesOpen ? (
        <p className="text-sm text-foreground-muted text-pretty">{t(`pass.blocked.${block}`)}</p>
      ) : null}
    </section>
  );
}
