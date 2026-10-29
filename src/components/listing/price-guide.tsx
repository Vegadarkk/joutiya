import { getTranslations } from "next-intl/server";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { formatPrice, groupDigits } from "@/lib/listings/client/format";
import { rangePosition, scalePosition, type PriceGuide } from "@/lib/price-guide/rules";

// « Prix repère » block of a listing page (Carte vivante lot 5), rendered on the server with the
// page (ISR, no script): the scale of the comparable prices (outliers dropped), the typical range
// (P25-P75) as a deeper band, the listing's price as a marker, how many listings and where. Joutiya
// is a neutral host: the block positions the price, it never says "bon prix" or "trop cher". The
// scale follows the reading direction (low price on the right in Arabic).

export interface PriceGuideBlockProps {
  guide: PriceGuide;
  /** The listing's price (MAD): the marker. */
  price: number;
  locale: Locale;
  className?: string;
}

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

function placeLabel(guide: PriceGuide, locale: Locale): { scope: "city" | "region" | "country"; name: string } {
  if (guide.scope === "city") {
    const city = cityBySlug(guide.place);
    if (city) return { scope: "city", name: cityName(city, locale) };
  }
  if (guide.scope === "region") {
    const region = regionByCode(guide.place);
    if (region) return { scope: "region", name: regionName(region, locale) };
  }
  return { scope: "country", name: "" };
}

export async function PriceGuideBlock({ guide, price, locale, className }: PriceGuideBlockProps) {
  const t = await getTranslations({ locale, namespace: "PriceGuide" });
  const place = placeLabel(guide, locale);
  const bandStart = scalePosition(guide, guide.p25);
  const bandEnd = scalePosition(guide, guide.p75);
  const marker = scalePosition(guide, price);
  const range = guide.p25 === guide.p75 ? formatPrice(guide.p25, locale) : t("range", { low: groupDigits(String(guide.p25)), high: formatPrice(guide.p75, locale) });
  const where = place.scope === "country" ? t("scope.country") : t(`scope.${place.scope}`, { place: place.name });
  return (
    <section aria-labelledby="price-guide-title" data-testid="price-guide" data-scope={guide.scope} className={className}>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface px-3.5 pt-3 pb-3.5">
        <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span id="price-guide-title" className="text-sm font-semibold">
            {t("title")}
          </span>
          <span className="text-xs text-foreground-muted" data-testid="price-guide-count">
            {t("count", { count: guide.count, where })}
          </span>
        </p>
        <div className="relative h-5" aria-hidden="true">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-bab-100 dark:bg-bab-800" />
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-bab-300 dark:bg-bab-400"
            style={{ insetInlineStart: percent(bandStart), width: percent(Math.max(0.02, bandEnd - bandStart)) }}
          />
          <div
            data-testid="price-guide-marker"
            className="absolute top-1/2 size-4 -translate-y-1/2 rounded-full border-2 border-surface bg-primary shadow-[0_1px_3px_rgb(11_30_31/0.35)] ltr:-translate-x-1/2 rtl:translate-x-1/2"
            style={{ insetInlineStart: percent(marker) }}
          />
        </div>
        <p className="flex items-baseline justify-between gap-2 text-xs text-foreground-muted tabular-nums">
          <span>{groupDigits(String(guide.low))}</span>
          <span className="font-medium text-foreground" data-testid="price-guide-range">
            {range}
          </span>
          <span>{groupDigits(String(guide.high))}</span>
        </p>
        <p className="sr-only">{t(`position.${rangePosition(guide, price)}`, { price: formatPrice(price, locale), range })}</p>
      </div>
      <p className="mt-1.5 text-xs text-foreground-muted text-pretty">{t("notice")}</p>
    </section>
  );
}
