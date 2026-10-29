import { useTranslations } from "next-intl";
import type { PriceUnit } from "@/config/categories";
import type { Locale } from "@/config/site";
import { formatPrice } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// The price of a listing (D4): an integer MAD as "1 500 DH" / "1 500 درهم", "Don" for a donation,
// "Prix à discuter" when the subcategory allows no amount. No `dir` override: the digit groups are
// joined by U+202F (a bidi common separator), so Arabic reads "1 500 درهم" in its own order.

export interface PriceTagProps {
  price: number | null;
  isDonation: boolean;
  negotiable?: boolean;
  /** Vacation rentals (night), rentals (month), equipment hire (day): from the subcategory. */
  unit?: PriceUnit;
  locale: Locale;
  /** Combinations at different prices: `price` is the lowest (« À partir de 450 DH »). */
  from?: boolean;
  size?: "sm" | "lg";
  className?: string;
}

export function PriceTag({ price, isDonation, negotiable = false, unit, locale, from = false, size = "sm", className }: PriceTagProps) {
  const t = useTranslations("ListingCard");
  const large = size === "lg";
  const amount = isDonation ? t("donation") : price === null ? t("toDiscuss") : formatPrice(price, locale);
  const showExtras = !isDonation && price !== null;
  return (
    <p data-testid="price-tag" className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", className)}>
      {showExtras && from ? <span className={cn("text-foreground-muted", large ? "text-base" : "text-xs")}>{t("from")}</span> : null}
      <span
        className={cn(
          "font-semibold whitespace-nowrap tabular-nums",
          large ? "text-2xl sm:text-3xl" : "text-base",
          isDonation && "text-success",
          price === null && !isDonation && (large ? "text-xl sm:text-2xl" : "text-sm text-foreground-muted"),
        )}
      >
        {amount}
      </span>
      {showExtras && unit ? <span className={cn("text-foreground-muted", large ? "text-base" : "text-xs")}>{t(`per.${unit}`)}</span> : null}
      {showExtras && negotiable ? (
        <span className={cn("rounded-sm bg-surface-muted font-medium text-foreground-muted", large ? "px-2 py-0.5 text-sm" : "px-1.5 text-xs")}>{t("negotiable")}</span>
      ) : null}
    </p>
  );
}
