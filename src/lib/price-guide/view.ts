import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { formatPrice, groupDigits } from "@/lib/listings/client/format";
import { rangePosition, scalePosition, type PriceGuide } from "./rules";

// What the « Prix repère » scale shows (Carte vivante lot 5), worked out on the server: positions on
// the scale (0 to 1, in reading order) and the texts in the page's language. The listing page and the
// map's detail panel preview (src/lib/search/preview.ts) share it; the markup is PriceGuideScale.

export interface PriceGuideView {
  scope: PriceGuide["scope"];
  /** The typical range (P25-P75) on the scale, and the listing's price. */
  bandStart: number;
  bandEnd: number;
  marker: number;
  /** Ends of the scale, grouped digits. */
  low: string;
  high: string;
  title: string;
  /** "12 annonces comparables à Casablanca". */
  count: string;
  /** The typical range, with the currency. */
  range: string;
  /** Where the price sits, for screen readers (a position, never a judgement). */
  position: string;
  notice: string;
}

/** A `PriceGuide` namespace translator (next-intl's own types are per namespace). */
export type PriceGuideTranslator = (key: string, values?: Record<string, string | number>) => string;

function placeOf(guide: PriceGuide, locale: Locale): { scope: "city" | "region" | "country"; name: string } {
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

export function priceGuideView(guide: PriceGuide, price: number, locale: Locale, t: PriceGuideTranslator): PriceGuideView {
  const place = placeOf(guide, locale);
  const range = guide.p25 === guide.p75 ? formatPrice(guide.p25, locale) : t("range", { low: groupDigits(String(guide.p25)), high: formatPrice(guide.p75, locale) });
  const where = place.scope === "country" ? t("scope.country") : t(`scope.${place.scope}`, { place: place.name });
  return {
    scope: guide.scope,
    bandStart: scalePosition(guide, guide.p25),
    bandEnd: scalePosition(guide, guide.p75),
    marker: scalePosition(guide, price),
    low: groupDigits(String(guide.low)),
    high: groupDigits(String(guide.high)),
    title: t("title"),
    count: t("count", { count: guide.count, where }),
    range,
    position: t(`position.${rangePosition(guide, price)}`, { price: formatPrice(price, locale), range }),
    notice: t("notice"),
  };
}
