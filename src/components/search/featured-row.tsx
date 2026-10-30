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
// each card carrying "À la Une · Sponsorisé". Phones: the 2 columns of the results grid. From md
// the cards turn wide (photo beside the text) so 2 of them fill the band, which would otherwise
// leave half of a 4-column row empty; a lone card spans the band. Under an empty result the band
// stays (paid slots) but reads "Vous aimerez peut-être", so "0 annonce" and listings do not clash
// (UX audit, 2); the "Sponsorisé" mark and the cards' badges stay.

/** Heading of a sponsored section: title, "Sponsorisé" mark and what the slots are. */
export function FeaturedHeading({ id, className, empty = false }: { id: string; className?: string; empty?: boolean }) {
  const t = useTranslations("SearchPage.featured");
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <h2 id={id} className="text-base font-semibold sm:text-lg">
        {t(empty ? "emptyTitle" : "title")}
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
  /** The result is empty: the band is titled "Vous aimerez peut-être". */
  empty?: boolean;
}

/** Organic results minus the cards of the band above them: a listing never shows twice on a page. */
export function withoutFeatured<T extends { id: string }>(cards: T[], featured: readonly { id: string }[]): T[] {
  if (featured.length === 0) return cards;
  const shown = new Set(featured.map((card) => card.id));
  return cards.filter((card) => !shown.has(card.id));
}

export function FeaturedRow({ cards, locale, renderAction, className, empty = false }: FeaturedRowProps) {
  if (cards.length === 0) return null;
  const media = mediaBaseUrl();
  return (
    <section aria-labelledby="featured-row-title" data-testid="featured-row" className={cn("threshold rounded-lg bg-surface-brand/70 px-3 pt-2 pb-5 sm:px-4", className)}>
      <FeaturedHeading id="featured-row-title" className="mb-3" empty={empty} />
      <ul className={cn(RESULTS_GRID_CLASS, "sm:grid-cols-2 lg:grid-cols-2")}>
        {cards.map((card) => (
          <li key={card.id} className={cn("min-w-0", cards.length === 1 && "md:col-span-2")}>
            <ListingCard listing={card} mediaBaseUrl={media} locale={locale} badge="featured" action={renderAction?.(card)} priority wide />
          </li>
        ))}
      </ul>
    </section>
  );
}
