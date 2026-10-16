import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ListingCard } from "@/components/listing/listing-card";
import type { Locale } from "@/config/site";
import type { SearchCard } from "@/lib/search/types";
import { mediaBaseUrl } from "@/lib/storage/keys";
import { cn } from "@/lib/utils";
import { RESULTS_GRID_CLASS } from "./grid";
import { SponsoredInfo } from "./sponsored-info";

// À la Une slots above the results (design D8, §8): up to 2 paid cards drawn at random on page 1,
// set apart from the organic results on a cream band standing on the gold threshold of the door,
// each card carrying "À la Une · Sponsorisé". Same columns as the results grid below it.

/** Heading of a sponsored section: title, "Sponsorisé" mark and what the slots are. */
export function FeaturedHeading({ id, className }: { id: string; className?: string }) {
  const t = useTranslations("SearchPage.featured");
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <h2 id={id} className="text-base font-semibold sm:text-lg">
        {t("title")}
      </h2>
      <span className="rounded-sm bg-featured px-1.5 py-0.5 text-xs font-medium text-featured-foreground">{t("sponsored")}</span>
      <SponsoredInfo label={t("infoLabel")} text={t("info")} className="-my-2 ms-auto" />
    </div>
  );
}

export interface FeaturedRowProps {
  cards: SearchCard[];
  locale: Locale;
  renderAction?: (card: SearchCard) => ReactNode;
  className?: string;
}

export function FeaturedRow({ cards, locale, renderAction, className }: FeaturedRowProps) {
  if (cards.length === 0) return null;
  const media = mediaBaseUrl();
  return (
    <section aria-labelledby="featured-row-title" data-testid="featured-row" className={cn("threshold rounded-lg bg-surface-brand/70 px-3 pt-2 pb-5 sm:px-4", className)}>
      <FeaturedHeading id="featured-row-title" className="mb-3" />
      <ul className={RESULTS_GRID_CLASS}>
        {cards.map((card) => (
          <li key={card.id} className="min-w-0">
            <ListingCard listing={card} mediaBaseUrl={media} locale={locale} badge="featured" action={renderAction?.(card)} priority />
          </li>
        ))}
      </ul>
    </section>
  );
}
