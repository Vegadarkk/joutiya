"use client";

import { useTranslations } from "next-intl";
import { Clock } from "lucide-react";
import type { PriceUnit, Subcategory } from "@/config/categories";
import type { Locale } from "@/config/site";
import { promoRunning, promoSummary, type PromoView } from "@/lib/contracts/catalog-core";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { intlLocale } from "@/lib/listings/client/format";
import { PriceTag } from "./price-tag";
import { PromoBadge } from "./promo-badge";
import { useNow } from "./use-now";

// The price on a listing page, with its promotion while it runs (catalogue §4, art. 54): the
// promotional price in red, the struck-out price (lowest of the 30 days before), the badge, the
// period, and for a flash sale (or a last day) the time left. The page is ISR: the clock here starts
// and ends the promotion on time, whatever the age of the HTML.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface ListingPriceProps {
  price: number | null;
  /** Combinations at different prices: `price` is the lowest. */
  from: boolean;
  isDonation: boolean;
  negotiable: boolean;
  unit?: PriceUnit;
  /** "salary": a job offer's monthly gross salary, said above the amount; "none": nothing shown. */
  mode?: Subcategory["priceMode"];
  locale: Locale;
  promo: PromoView | null;
  /** Epoch ms of the server render. */
  renderedAt: number;
}

export function ListingPrice({ price, from, isDonation, negotiable, unit, mode, locale, promo, renderedAt }: ListingPriceProps) {
  const t = useTranslations("ListingPage.salary");
  const now = useNow(renderedAt, 15_000, promo !== null);
  const summary = promo && promoRunning(promo, now) ? promoSummary(promo) : null;
  if (mode === "none") return null;
  return (
    <div data-testid="listing-price" className="flex flex-col gap-2">
      {/* The label makes sense above an amount; « Salaire à convenir » says it all. */}
      {mode === "salary" && price !== null ? <span className="text-sm text-foreground-muted">{t("label")}</span> : null}
      <PriceTag
        price={summary ? summary.price : price}
        from={summary && promo ? new Set(promo.prices.map((entry) => entry.price)).size > 1 : from}
        isDonation={isDonation}
        negotiable={negotiable}
        unit={unit}
        mode={mode}
        locale={locale}
        promo={summary !== null}
        before={summary?.reference ?? null}
        size="lg"
      />
      {summary && promo ? <PromoNotice promo={promo} percent={summary.percent} reference={summary.reference} now={now} locale={locale} /> : null}
    </div>
  );
}

function PromoNotice({ promo, percent, reference, now, locale }: { promo: PromoView; percent: number; reference: number | null; now: number; locale: Locale }) {
  const t = useTranslations("ListingPage.promo");
  // Morocco's wall clock whatever the browser's time zone data (src/lib/i18n/morocco-time.ts).
  const format = (at: number) => new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: moroccoTimeZone(at) }).format(at);
  const left = promo.endsAt - now;
  const countdown = promo.kind === "flash" || left < DAY_MS;
  const hours = Math.floor(left / HOUR_MS);
  const minutes = Math.max(1, Math.ceil((left % HOUR_MS) / MINUTE_MS));
  return (
    <div data-testid="promo-notice" className="flex flex-col gap-1.5 self-start text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PromoBadge kind={promo.kind} percent={percent} size="lg" />
        <span className="text-foreground-muted">{t("period", { start: format(promo.startsAt), end: format(promo.endsAt) })}</span>
      </p>
      {countdown ? (
        <p data-testid="promo-countdown" role="timer" className="inline-flex items-center gap-1.5 font-medium text-danger tabular-nums">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {hours > 0 ? t("endsInHours", { hours, minutes: minutes === 60 ? 59 : minutes }) : t("endsInMinutes", { minutes })}
        </p>
      ) : null}
      <p className="text-xs text-foreground-muted text-pretty">{reference !== null ? t("reference") : t("noReference")}</p>
    </div>
  );
}
