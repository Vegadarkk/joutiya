"use client";

import { Camera, Heart, ImageOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { subcategoryById } from "@/config/categories";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { blurhashPlaceholder, photoSources } from "@/components/listing/photo";
import { PriceTag } from "@/components/listing/price-tag";
import { quietLinkClassName, textLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import type { FavoriteView } from "@/lib/contracts/search";
import { intlLocale } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// A favorite on "Mes favoris" (design D17): the listing card footprint (4:3 photo, title, price,
// place), with the date it was kept. A listing that left the search (sold, expired, paused,
// removed) keeps its saved snapshot in faded tones, says "Plus disponible" and offers only removal.

/** Same grid as the listing cards (LISTING_CARD_SIZES of listing-card.tsx, a server module). */
const CARD_SIZES = "(min-width: 1024px) 18rem, (min-width: 640px) 33vw, 50vw";

export function formatSavedDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "long", timeZone: "Africa/Casablanca" }).format(new Date(iso));
}

export interface FavoriteCardProps {
  favorite: FavoriteView;
  mediaBaseUrl: string | null;
  locale: Locale;
  busy?: boolean;
  onRemove: () => void;
}

export function FavoriteCard({ favorite, mediaBaseUrl, locale, busy = false, onRemove }: FavoriteCardProps) {
  const t = useTranslations("Favorites.page");
  const card = favorite.card;
  const available = favorite.available;
  const city = card.citySlug ? cityBySlug(card.citySlug) : undefined;
  const unit = card.subcategoryId ? subcategoryById(card.subcategoryId)?.priceUnit : undefined;
  const sources = card.photo ? photoSources(mediaBaseUrl, card.id, card.photo, "s") : null;
  const placeholder = blurhashPlaceholder(card.photo?.blurhash);

  return (
    <article
      data-testid="favorite-card"
      data-available={available}
      className={cn(
        "group relative flex min-w-0 flex-col gap-1.5 rounded-lg",
        available && "has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-ring",
      )}
    >
      <div
        className={cn("relative mb-1 aspect-[4/3] overflow-hidden rounded-lg bg-surface-muted bg-cover bg-center", !available && "grayscale")}
        style={placeholder ? { backgroundImage: `url("${placeholder}")` } : undefined}
      >
        {sources ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sources.src}
            srcSet={sources.srcSet}
            sizes={CARD_SIZES}
            width={sources.width}
            height={sources.height}
            alt=""
            loading="lazy"
            decoding="async"
            className={cn("absolute inset-0 size-full object-cover", !available && "opacity-60")}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-foreground-muted">
            <ImageOff className="size-6" aria-hidden="true" strokeWidth={1.5} />
          </span>
        )}
        {available && card.photoCount > 1 ? (
          <span className="absolute bottom-2 end-2 inline-flex items-center gap-1 rounded-sm bg-bab-950/70 px-1.5 py-0.5 text-xs font-medium text-cream-100 tabular-nums">
            <Camera className="size-3.5" aria-hidden="true" />
            <span aria-hidden="true">{card.photoCount}</span>
          </span>
        ) : null}
        {available ? null : (
          // The cream band of the brand over the faded photo: the state reads before the title.
          <span className="absolute inset-x-0 bottom-0 bg-cream-200/95 px-3 py-1.5 text-center text-xs font-semibold text-bab-950">{t("unavailable")}</span>
        )}
        {available ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            aria-label={t("removeOf", { title: card.title })}
            className="group/fav absolute top-0 end-0 z-10 inline-flex size-11 items-center justify-center rounded-full outline-none disabled:opacity-60 [&:focus-visible>span]:outline-2 [&:focus-visible>span]:outline-offset-0 [&:focus-visible>span]:outline-ring"
          >
            <span className="inline-flex size-9 items-center justify-center rounded-full bg-surface/90 shadow-sm shadow-bab-950/20 backdrop-blur-sm transition-[background-color,scale] duration-150 ease-door group-hover/fav:bg-surface group-active/fav:scale-90">
              <Heart aria-hidden="true" className="size-5 fill-primary text-primary" />
            </span>
          </button>
        ) : null}
      </div>
      <h2 className={cn("text-sm font-medium leading-snug", !available && "text-foreground-muted")}>
        {available ? (
          <Link
            href={`/annonce/${card.slugId}`}
            prefetch={false}
            className={cn("line-clamp-2 break-words outline-none", quietLinkClassName, "group-hover:decoration-current after:absolute after:inset-0 after:rounded-lg")}
          >
            {card.title}
          </Link>
        ) : (
          <span className="line-clamp-2 break-words">{card.title}</span>
        )}
      </h2>
      <PriceTag price={card.price} isDonation={card.isDonation} negotiable={card.priceNegotiable} unit={unit} locale={locale} className={cn(!available && "opacity-70")} />
      <p className="flex min-w-0 flex-wrap gap-x-2 text-xs text-foreground-muted">
        {city ? <span className="truncate">{cityName(city, locale)}</span> : null}
        <span>{t("savedOn", { date: formatSavedDate(favorite.createdAt, locale) })}</span>
      </p>
      {available ? null : (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={t("removeOf", { title: card.title })}
          className={cn("mt-1 inline-flex min-h-11 items-center gap-1.5 self-start rounded-md px-1 text-sm font-medium text-link disabled:opacity-60 sm:min-h-9", textLinkClassName)}
        >
          {t("remove")}
        </button>
      )}
    </article>
  );
}
