import { Fragment, type ReactNode } from "react";
import { ListingCard } from "@/components/listing/listing-card";
import type { Locale } from "@/config/site";
import type { SearchCard } from "@/lib/search/types";
import { mediaBaseUrl } from "@/lib/storage/keys";
import { cn } from "@/lib/utils";
import { cardBadge } from "./filter-model";
import { RESULTS_GRID_CLASS } from "./grid";

// Grid of engine cards (search page, home, /c pages of L4): 2 columns on phones, 3 from sm, 4 from
// lg, the ListingGridSkeleton footprint. Server component (reads the media host). `renderAction`
// puts a client island on each card (L5's FavoriteButton, wired by the page).

export interface ResultsGridProps {
  cards: SearchCard[];
  locale: Locale;
  renderAction?: (card: SearchCard) => ReactNode;
  /** Cards whose photo loads eagerly with high priority (first row: LCP). */
  priorityCount?: number;
  headingLevel?: "h2" | "h3";
  className?: string;
  /**
   * Full-width rows inserted after the given card counts (phase 6 in-feed ads, D6). The grid then
   * packs densely: the cards of a row the insert cannot share fill it first, so no hole is left.
   */
  inserts?: { after: readonly number[]; render: (after: number) => ReactNode };
}

export function ResultsGrid({ cards, locale, renderAction, priorityCount = 0, headingLevel, className, inserts }: ResultsGridProps) {
  const media = mediaBaseUrl();
  const after = new Set(inserts?.after);
  return (
    <ul data-testid="results-grid" className={cn(RESULTS_GRID_CLASS, inserts && "grid-flow-row-dense", className)}>
      {cards.map((card, index) => (
        <Fragment key={card.id}>
          <li className="min-w-0">
            <ListingCard listing={card} mediaBaseUrl={media} locale={locale} headingLevel={headingLevel} badge={cardBadge(card)} action={renderAction?.(card)} priority={index < priorityCount} />
          </li>
          {inserts && after.has(index + 1) ? <li className="col-span-full">{inserts.render(index + 1)}</li> : null}
        </Fragment>
      ))}
    </ul>
  );
}
