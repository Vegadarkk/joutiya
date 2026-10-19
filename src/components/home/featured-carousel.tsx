import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ListingCard } from "@/components/listing/listing-card";
import { FeaturedHeading } from "@/components/search/featured-row";
import type { Locale } from "@/config/site";
import type { SearchCard } from "@/lib/search/types";
import { mediaBaseUrl } from "@/lib/storage/keys";
import { cn } from "@/lib/utils";
import { ScrollRow } from "./scroll-row";

// À la Une on the home page (design D8, D21): 8 sponsored cards drawn from the pool, in one
// scrolling row on the cream band of the search page's slots. Hidden when there is none.

export function FeaturedCarousel({ cards, locale, renderAction, className }: { cards: SearchCard[]; locale: Locale; renderAction?: (card: SearchCard) => ReactNode; className?: string }) {
  const t = useTranslations("Home.featured");
  if (cards.length === 0) return null;
  const media = mediaBaseUrl();
  return (
    <section aria-labelledby="home-featured" data-testid="home-featured" className={cn("threshold rounded-lg bg-surface-brand/70 px-4 pt-3 pb-5 sm:px-6", className)}>
      <FeaturedHeading id="home-featured" className="mb-3" />
      <ScrollRow previousLabel={t("previous")} nextLabel={t("next")}>
        <ul className="flex gap-3 sm:gap-4">
          {cards.map((card) => (
            <li key={card.id} className="w-[44vw] max-w-60 shrink-0 snap-start sm:w-[calc((100%-2rem)/3)] sm:max-w-none lg:w-[calc((100%-3rem)/4)]">
              <ListingCard listing={card} mediaBaseUrl={media} locale={locale} badge="featured" action={renderAction?.(card)} />
            </li>
          ))}
        </ul>
      </ScrollRow>
    </section>
  );
}
