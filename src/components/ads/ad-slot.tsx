import { useLocale, useTranslations } from "next-intl";
import { AD_PLACEMENTS, type AdPlacement } from "@/config/ads";
import { pickPromo, type HousePromo as Promo } from "@/config/house-promos";
import { SITE_NAME } from "@/config/site";
import { AdUnit } from "./ad-unit";
import { HousePromo } from "./house-promo";

// Advertising slot (phase 6, D4, D6, D7). The server renders the house promotion inside a box of
// the unit's fixed size; the client swaps in an ad only when the page is eligible and the visitor's
// region and consent allow it, and puts the promotion back when the ad does not come. Never ads
// on Tarifit pages (AdSense does not support the language).

export interface AdSlotProps {
  placement: AdPlacement;
  /** The page may carry ads (D6: listing `adsEligible`, search with results, home). */
  eligible: boolean;
  /** Promotions open right now (`availablePromos(await getFlags())`). */
  promos: readonly Promo[];
  /** Picks the promotion (same page, same promotion). */
  seed: string;
  className?: string;
}

export function AdSlot({ placement, eligible, promos, seed, className }: AdSlotProps) {
  const t = useTranslations("Ads");
  const locale = useLocale();
  const { format, ...where } = AD_PLACEMENTS[placement];
  return (
    <AdUnit
      placement={placement}
      format={format}
      media={"media" in where ? where.media : undefined}
      hide={"hide" in where ? where.hide : undefined}
      eligible={eligible && locale !== "rif"}
      labels={{ ad: t("label"), promo: SITE_NAME, promoRegion: t("promoLabel", { brand: SITE_NAME }) }}
      className={className}
    >
      <HousePromo promo={pickPromo(promos, `${placement}:${seed}`)} format={format} />
    </AdUnit>
  );
}
