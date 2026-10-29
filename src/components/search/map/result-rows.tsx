import type { ReactNode } from "react";
import { ImageOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { rentalFragment } from "@/components/rental/rental-day";
import { BoostBadge } from "@/components/search/boost-badge";
import { quietLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import type { SearchCard } from "@/lib/search/types";
import { cn } from "@/lib/utils";
import type { MapListing } from "./map-listings";

// The results as rows of the map panel (Carte vivante, lot 2): an arch thumbnail, the price, the
// title (the row's one link, stretched over it), place and date, and the favourite heart. Server
// rendered: without script it is the whole results list. The À la Une rows come first, with their
// §8 mention. `data-map-row` ties a row to its pin (map-controls.tsx, search-map.tsx).

export interface ResultRowsProps {
  listings: readonly MapListing[];
  /** The cards, for the car rental fragment of a search by dates. */
  cards: ReadonlyMap<string, SearchCard>;
  renderAction?: (listing: MapListing) => ReactNode;
  /** Eager thumbnails at the top (the map view is the first paint). */
  priorityCount?: number;
  label: string;
}

export function ResultRows({ listings, cards, renderAction, priorityCount = 0, label }: ResultRowsProps) {
  const t = useTranslations("SearchMap.row");
  return (
    <ul aria-label={label} data-testid="result-rows" className="flex flex-col gap-1">
      {listings.map((listing, index) => {
        const rental = cards.get(listing.id)?.rental;
        const href = rental ? `/annonce/${listing.slugId}${rentalFragment(rental)}` : `/annonce/${listing.slugId}`;
        return (
          <li
            key={listing.id}
            data-map-row=""
            data-listing-id={listing.id}
            className={cn(
              "group/row relative grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border border-transparent p-2",
              "transition-[background-color,border-color] duration-150 ease-door hover:bg-surface-muted",
              "data-[highlight]:border-gold-400/70 data-[highlight]:bg-cream-100 data-[selected]:border-gold-400 data-[selected]:bg-cream-100",
              "dark:data-[highlight]:bg-bab-800 dark:data-[selected]:bg-bab-800",
              "has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring",
            )}
          >
            <div
              className="relative aspect-[4/3] overflow-hidden rounded-t-[3.25rem] rounded-b-lg bg-surface-muted bg-cover bg-center"
              style={listing.photo?.placeholder ? { backgroundImage: `url("${listing.photo.placeholder}")` } : undefined}
            >
              {listing.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={listing.photo.src}
                  srcSet={listing.photo.srcSet}
                  sizes="7rem"
                  width={listing.photo.width}
                  height={listing.photo.height}
                  alt=""
                  loading={index < priorityCount ? "eager" : "lazy"}
                  decoding="async"
                  className="absolute inset-0 size-full object-cover"
                />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-foreground-muted">
                  <ImageOff className="size-5" strokeWidth={1.5} aria-hidden="true" />
                  <span className="sr-only">{t("noPhoto")}</span>
                </span>
              )}
              {listing.featured ? <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-featured ring-inset" /> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
              {listing.featured || listing.bumped ? <BoostBadge kind={listing.featured ? "featured" : "bumped"} className="mb-0.5 self-start" /> : null}
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-base font-semibold tabular-nums">
                <span className="whitespace-nowrap">{listing.amount}</span>
                {listing.per ? <span className="text-xs font-normal text-foreground-muted">{listing.per}</span> : null}
              </p>
              <h3 className="text-sm leading-snug ltr:text-left rtl:text-right">
                <Link
                  href={href}
                  prefetch={false}
                  dir="auto"
                  data-row-link=""
                  className={cn("line-clamp-2 break-words outline-none", quietLinkClassName, "group-hover/row:decoration-current after:absolute after:inset-0 after:rounded-xl")}
                >
                  {listing.title}
                </Link>
              </h3>
              <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-foreground-muted">
                {listing.place ? <span className="truncate">{listing.place}</span> : null}
                {listing.place ? <span aria-hidden="true">·</span> : null}
                {listing.today ? <span aria-hidden="true" className="today-dot" /> : null}
                <time dateTime={listing.dateTime} className={cn(listing.today && "font-medium text-foreground")}>
                  {listing.date}
                </time>
              </p>
              {listing.pro || listing.facts.length > 0 ? (
                <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                  {listing.pro ? <span className="rounded-sm bg-structure px-1.5 py-px font-medium text-structure-foreground">{t("pro")}</span> : null}
                  {listing.facts.length > 0 ? <span className="truncate text-foreground-muted tabular-nums">{listing.facts.join(" · ")}</span> : null}
                </p>
              ) : null}
            </div>
            {renderAction && !listing.example ? <div className="relative z-10 -me-1 -mt-1">{renderAction(listing)}</div> : <span />}
          </li>
        );
      })}
    </ul>
  );
}
