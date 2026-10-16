"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PriceUnit } from "@/config/categories";
import type { Locale } from "@/config/site";
import { currencyLabel, groupDigits, parsePriceInput } from "@/lib/listings/client/format";
import { PRICE_MAX } from "@/lib/listings/client/validation";
import { cn } from "@/lib/utils";
import { SwitchField } from "./controls/switch";

// Step 6 (design D4): integer dirhams with thousands grouping as you type, "Négociable",
// "Je donne" when the subcategory allows donations, "À discuter" when the price is optional, and
// the unit ("par nuit", "par mois") when the subcategory sets one.

export interface PriceInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  negotiable: boolean;
  onNegotiable: (value: boolean) => void;
  isDonation: boolean;
  onDonation: (value: boolean) => void;
  donationAllowed: boolean;
  priceOptional: boolean;
  priceUnit?: PriceUnit;
  error?: string;
  onBlur?: () => void;
  /** Overrides the hook (unit tests render without a provider for the locale). */
  locale?: Locale;
}

export function PriceInput({ value, onChange, negotiable, onNegotiable, isDonation, onDonation, donationAllowed, priceOptional, priceUnit, error, onBlur, locale: localeProp }: PriceInputProps) {
  const t = useTranslations("Listing.fields");
  const hookLocale = useLocale() as Locale;
  const locale = localeProp ?? hookLocale;
  // "À discuter": the person asked for no amount (distinct from "not typed yet").
  const [toDiscuss, setToDiscuss] = useState(priceOptional && value === null && !isDonation);
  const input = useRef<HTMLInputElement>(null);
  // Digits only, grouped as you type: the text is a pure function of the integer value.
  const text = value === null ? "" : groupDigits(String(value));

  const disabled = isDonation || toDiscuss;

  return (
    <div className="flex flex-col gap-5" onBlur={onBlur}>
      <Field label={t("price")} hint={disabled ? undefined : t("priceHint")} error={error} required={!priceOptional && !isDonation}>
        <div className="relative">
          <Input
            ref={input}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder={disabled ? "" : t("pricePlaceholder")}
            value={isDonation ? "0" : toDiscuss ? "" : text}
            disabled={disabled}
            dir="ltr"
            className={cn("h-14 pe-20 text-start text-2xl font-semibold tabular-nums", disabled && "text-foreground-muted")}
            onChange={(event) => {
              const parsed = parsePriceInput(event.target.value);
              onChange(parsed === null ? null : Math.min(parsed, PRICE_MAX * 10));
            }}
          />
          <span className="pointer-events-none absolute end-4 top-1/2 flex -translate-y-1/2 flex-col items-end leading-tight" aria-hidden="true">
            <span className="text-lg font-medium text-foreground-muted">{currencyLabel(locale)}</span>
            {priceUnit ? <span className="text-xs text-foreground-muted">{t(`per.${priceUnit}`)}</span> : null}
          </span>
        </div>
      </Field>

      <div className="flex flex-col divide-y divide-border rounded-lg border border-border px-4">
        {priceOptional ? (
          <SwitchField
            label={t("toDiscuss")}
            hint={t("toDiscussHint")}
            checked={toDiscuss}
            disabled={isDonation}
            onCheckedChange={(checked) => {
              setToDiscuss(checked);
              if (checked) onChange(null);
              // Back to an amount: the field is where the next keystroke goes.
              else requestAnimationFrame(() => input.current?.focus());
            }}
            className="py-3"
          />
        ) : null}
        <SwitchField label={t("negotiable")} hint={t("negotiableHint")} checked={negotiable && !isDonation} disabled={isDonation} onCheckedChange={onNegotiable} className="py-3" />
        {donationAllowed ? (
          <SwitchField
            label={t("donation")}
            hint={t("donationHint")}
            checked={isDonation}
            onCheckedChange={(checked) => {
              onDonation(checked);
              if (checked) {
                setToDiscuss(false);
                onChange(null);
                onNegotiable(false);
              } else requestAnimationFrame(() => input.current?.focus());
            }}
            className="py-3"
          />
        ) : null}
      </div>
    </div>
  );
}
