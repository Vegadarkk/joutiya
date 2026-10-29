import { getTranslations } from "next-intl/server";
import type { Locale } from "@/config/site";
import type { PriceGuide } from "@/lib/price-guide/rules";
import { priceGuideView, type PriceGuideTranslator } from "@/lib/price-guide/view";
import { PriceGuideScale } from "./price-guide-scale";

// « Prix repère » block of a listing page (Carte vivante lot 5), rendered on the server with the
// page (ISR, no script). Texts and positions: src/lib/price-guide/view.ts; markup: PriceGuideScale.

export interface PriceGuideBlockProps {
  guide: PriceGuide;
  /** The listing's price (MAD): the marker. */
  price: number;
  locale: Locale;
  className?: string;
}

export async function PriceGuideBlock({ guide, price, locale, className }: PriceGuideBlockProps) {
  const t = await getTranslations({ locale, namespace: "PriceGuide" });
  return <PriceGuideScale view={priceGuideView(guide, price, locale, t as unknown as PriceGuideTranslator)} titleId="price-guide-title" className={className} />;
}
