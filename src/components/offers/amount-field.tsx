"use client";

import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { inputClassName } from "@/components/ui/input";
import type { Locale } from "@/config/site";
import { currencyLabel, formatPrice, groupDigits, parsePriceInput } from "@/lib/listings/client/format";
import { offerBounds, offerProblem, type OfferProblem } from "@/lib/offers/rules";
import { roundingStep } from "@/lib/price-guide/rounding";
import { cn } from "@/lib/utils";

// The amount of an offer or a counter-offer (Carte vivante lot 5): whole dirhams typed with any
// digits (Arabic-Indic too), a few rounded suggestions under the price, the bounds (30 % of the
// price up to the price), and a slim gauge of where the amount sits between them. Zod-free: the
// listing page's message dialog loads it.

/** Shares of the price suggested as chips (rounded down to a readable step). */
const SUGGESTED_SHARES = [0.95, 0.9, 0.85] as const;

/** Readable amounts a little under `price`, within the bounds and above `above` (a counter-offer). */
export function suggestedAmounts(price: number, above?: number): number[] {
  const { min } = offerBounds(price);
  const step = roundingStep(price);
  const amounts = SUGGESTED_SHARES.map((share) => Math.floor((price * share) / step) * step).filter((amount) => amount >= min && amount < price && (above === undefined || amount > above));
  return [...new Set(amounts)];
}

/** Why the typed text cannot be sent, else null ("empty" when nothing is typed). */
export function amountProblem(text: string, price: number, above?: number): OfferProblem | "empty" | null {
  const amount = parsePriceInput(text);
  if (amount === null) return "empty";
  return offerProblem(amount, price, above);
}

export interface AmountFieldProps {
  /** The price the bounds are measured against (DH). */
  price: number;
  /** A counter-offer must be above the offer it answers. */
  above?: number;
  value: string;
  onChange: (value: string) => void;
  /** Shown once the user tried to send. */
  problem: OfferProblem | "empty" | null;
  label: string;
  disabled?: boolean;
}

export function AmountField({ price, above, value, onChange, problem, label, disabled }: AmountFieldProps) {
  const t = useTranslations("Offers.field");
  const locale = useLocale() as Locale;
  const id = useId();
  const bounds = offerBounds(price);
  const amount = parsePriceInput(value);
  const share = amount === null ? null : Math.min(1, Math.max(0, (amount - bounds.min) / Math.max(1, bounds.max - bounds.min)));
  const floor = above !== undefined ? Math.max(bounds.min, above + 1) : bounds.min;
  const message =
    problem === null
      ? null
      : problem === "too_low"
        ? t("problems.too_low", { min: formatPrice(bounds.min, locale) })
        : problem === "too_high"
          ? t("problems.too_high", { max: formatPrice(bounds.max, locale) })
          : problem === "not_above_offer"
            ? t("problems.not_above_offer", { amount: formatPrice(above ?? 0, locale) })
            : t(`problems.${problem}`);
  return (
    <div className="flex flex-col gap-2" data-testid="offer-amount">
      <label htmlFor={`${id}-amount`} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={`${id}-amount`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          dir="ltr"
          value={value}
          disabled={disabled}
          placeholder={groupDigits(String(suggestedAmounts(price, above)[0] ?? price))}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-bounds${message ? ` ${id}-problem` : ""}`}
          onChange={(event) => {
            const typed = parsePriceInput(event.target.value);
            onChange(typed === null ? "" : groupDigits(String(typed)));
          }}
          className={cn(inputClassName, "h-14 ps-4 pe-14 text-2xl font-semibold tabular-nums ltr:text-left rtl:text-right")}
        />
        <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-base font-medium text-foreground-muted" aria-hidden="true">
          {currencyLabel(locale)}
        </span>
      </div>
      {/* Where the amount sits between the lowest offer and the price. */}
      <div className="relative h-1.5 overflow-hidden rounded-full bg-bab-100 dark:bg-bab-800" aria-hidden="true">
        {share !== null && problem !== "too_low" && problem !== "too_high" ? (
          <div className="absolute inset-y-0 start-0 rounded-full bg-primary transition-[width] duration-200 ease-door" style={{ width: `${(share * 100).toFixed(1)}%` }} />
        ) : null}
      </div>
      <p id={`${id}-bounds`} className="flex flex-wrap justify-between gap-x-3 text-xs text-foreground-muted tabular-nums">
        <span>{t("bounds", { min: formatPrice(floor, locale), max: formatPrice(bounds.max, locale) })}</span>
        <span>{t("listed", { price: formatPrice(price, locale) })}</span>
      </p>
      {suggestedAmounts(price, above).length > 0 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("suggestions")}>
          {suggestedAmounts(price, above).map((suggestion) => {
            const selected = amount === suggestion;
            return (
              <button
                key={suggestion}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onChange(groupDigits(String(suggestion)))}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium tabular-nums transition-colors duration-150 ease-door",
                  selected ? "border-primary bg-primary/10 text-foreground" : "border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-muted",
                )}
              >
                {formatPrice(suggestion, locale)}
              </button>
            );
          })}
        </div>
      ) : null}
      {message ? <InlineError id={`${id}-problem`}>{message}</InlineError> : null}
    </div>
  );
}
