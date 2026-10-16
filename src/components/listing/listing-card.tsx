import type { ReactNode } from "react";
import { Camera, ImageOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { BoostBadge } from "@/components/search/boost-badge";
import type { CardBadge } from "@/components/search/filter-model";
import { subcategoryById } from "@/config/categories";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { intlLocale } from "@/lib/listings/client/format";
import type { PublicListingCard } from "@/lib/listings/public";
import { cn } from "@/lib/utils";
import { PriceTag } from "./price-tag";
import { blurhashPlaceholder, photoSources } from "./photo";

// A listing in a grid (profile page, search results, home, category pages): the footprint of
// ListingCardSkeleton (4:3 photo, title, price, place) so nothing shifts while a grid loads. The
// whole card is one link (stretched over the tile); grids hold many cards, so no prefetch. Phase 4
// (D22): an optional §8 mention under the place line and an action slot (the favorite heart) on
// the photo, both above the stretched link. Engine cards (SearchCard) have this shape too.

/** Grid columns: 2 on phones, 3 from sm, 4 from lg (ListingGridSkeleton). */
export const LISTING_CARD_SIZES = "(min-width: 1024px) 18rem, (min-width: 640px) 33vw, 50vw";

export interface ListingCardProps {
  listing: PublicListingCard;
  mediaBaseUrl: string | null;
  locale: Locale;
  /** Heading level of the title inside the surrounding page. */
  headingLevel?: "h2" | "h3";
  /** §8 mention: "À la Une · Sponsorisé" in a sponsored slot, "Remontée" after a paid bump. */
  badge?: CardBadge;
  /** Client island at the top end of the photo (FavoriteButton), above the stretched link. */
  action?: ReactNode;
  /** First cards of a page (largest contentful paint): eager, high-priority photo. */
  priority?: boolean;
  className?: string;
}

export function formatCardDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", timeZone: "Africa/Casablanca" }).format(new Date(iso));
}

export function ListingCard({ listing, mediaBaseUrl, locale, headingLevel = "h3", badge, action, priority = false, className }: ListingCardProps) {
  const t = useTranslations("ListingCard");
  const Heading = headingLevel;
  const city = listing.citySlug ? cityBySlug(listing.citySlug) : undefined;
  const unit = listing.subcategoryId ? subcategoryById(listing.subcategoryId)?.priceUnit : undefined;
  const sources = listing.photo ? photoSources(mediaBaseUrl, listing.id, listing.photo, "s") : null;
  const placeholder = blurhashPlaceholder(listing.photo?.blurhash);

  return (
    <article data-testid="listing-card" data-badge={badge} className={cn("group relative flex min-w-0 flex-col gap-1.5 rounded-lg has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-ring", className)}>
      <div
        className="relative mb-1 aspect-[4/3] overflow-hidden rounded-lg bg-surface-muted bg-cover bg-center"
        style={placeholder ? { backgroundImage: `url("${placeholder}")` } : undefined}
      >
        {sources ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sources.src}
            srcSet={sources.srcSet}
            sizes={LISTING_CARD_SIZES}
            width={sources.width}
            height={sources.height}
            alt=""
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : undefined}
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-foreground-muted">
            <ImageOff className="size-6" aria-hidden="true" strokeWidth={1.5} />
            <span className="text-xs">{t("noPhoto")}</span>
          </span>
        )}
        {listing.photoCount > 1 ? (
          <span className="absolute bottom-2 end-2 inline-flex items-center gap-1 rounded-sm bg-bab-950/70 px-1.5 py-0.5 text-xs font-medium text-cream-100 tabular-nums">
            <Camera className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("photos", { count: listing.photoCount })}</span>
            <span aria-hidden="true">{listing.photoCount}</span>
          </span>
        ) : null}
        {listing.sellerType === "pro" ? <span className="absolute top-2 start-2 rounded-sm bg-structure px-2 py-0.5 text-xs font-medium text-structure-foreground">{t("pro")}</span> : null}
        {action ? <div className="absolute top-1 end-1 z-10">{action}</div> : null}
      </div>
      <Heading className="text-sm font-medium leading-snug">
        <Link href={`/annonce/${listing.slugId}`} prefetch={false} className="line-clamp-2 break-words outline-none group-hover:underline group-hover:underline-offset-2 after:absolute after:inset-0 after:rounded-lg">
          {listing.title}
        </Link>
      </Heading>
      <PriceTag price={listing.price} isDonation={listing.isDonation} negotiable={listing.priceNegotiable} unit={unit} locale={locale} />
      <p className="flex min-w-0 flex-wrap gap-x-2 text-xs text-foreground-muted">
        {city ? <span className="truncate">{cityName(city, locale)}</span> : null}
        <time dateTime={listing.sortAt}>{formatCardDate(listing.sortAt, locale)}</time>
      </p>
      {badge ? <BoostBadge kind={badge} className="mt-1 self-start" /> : null}
    </article>
  );
}
