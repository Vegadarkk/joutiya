"use client";

import { useEffect, useId, useRef } from "react";
import { Camera, CalendarDays, Flag, ImageOff, MapPin, MessageCircle, SquareArrowOutUpRight, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { BoostBadge } from "@/components/search/boost-badge";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useSearchMap } from "./search-map-root";

// Detail of a result beside the desktop map (Carte vivante, lot 2): opened by a pin or a row, at the
// end side. Only what the results card already carries (photo, price, place, date, key facts, Pro
// mention, §8 mentions): contact, report and the full page stay on the listing page itself. A
// non-modal dialog: Escape and the close button shut it and focus returns to the opener.

export function DetailPanel() {
  const t = useTranslations("SearchMap.detail");
  const state = useSearchMap();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const open = state !== null && state.desktop && state.view === "map" && state.canMap ? state.selected : null;
  const listing = open ? state?.listings.find((item) => item.id === open) : undefined;
  const select = state?.select;

  useEffect(() => {
    if (!listing) return;
    heading.current?.focus({ preventScroll: true });
  }, [listing]);

  useEffect(() => {
    if (!listing || !select) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) select(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listing, select]);

  if (!listing || !select) return null;
  const href = `/annonce/${listing.slugId}`;
  // An example listing (src/lib/demo) names no seller type: it has no seller to contact.
  const seller = listing.example ? [] : listing.pro ? [t("pro")] : [t("individual")];
  const chips = [...listing.facts, ...seller, ...(listing.exclusive ? [t("exclusive")] : [])];

  return (
    <section role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="search-detail" className="search-detail float-card">
      <div className="relative mx-3 mt-3 shrink-0">
        <div
          className="relative aspect-[4/3] max-h-60 w-full overflow-hidden rounded-arch bg-surface-muted bg-cover bg-center"
          style={listing.photo?.placeholder ? { backgroundImage: `url("${listing.photo.placeholder}")` } : undefined}
        >
          {listing.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={listing.photo.src} srcSet={listing.photo.srcSet} sizes="24rem" width={listing.photo.width} height={listing.photo.height} alt="" decoding="async" className="absolute inset-0 size-full object-cover" />
          ) : (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-foreground-muted">
              <ImageOff className="size-7" strokeWidth={1.5} aria-hidden="true" />
              <span className="text-sm">{t("noPhoto")}</span>
            </span>
          )}
          {listing.photoCount > 1 ? (
            <span className="absolute end-3 bottom-3 inline-flex items-center gap-1 rounded-full bg-bab-950/75 px-2.5 py-1 text-xs font-medium text-cream-100 tabular-nums">
              <Camera className="size-3.5" aria-hidden="true" />
              {t("photos", { count: listing.photoCount })}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label={t("close")}
          data-testid="search-detail-close"
          className="absolute end-2 top-2 inline-flex size-11 items-center justify-center rounded-full bg-surface/95 text-foreground shadow-md shadow-bab-950/20 transition-[background-color,scale] duration-150 ease-door hover:bg-surface active:scale-95"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-4">
        {listing.featured || listing.bumped ? <BoostBadge kind={listing.featured ? "featured" : "bumped"} className="self-start" /> : null}
        {listing.example ? (
          <span data-testid="example-chip" className="self-start rounded-sm bg-featured px-2 py-0.5 text-xs font-semibold text-featured-foreground">
            {t("example")}
          </span>
        ) : null}
        <h2 id={titleId} ref={heading} tabIndex={-1} dir="auto" className="text-lg font-semibold leading-snug break-words outline-none ltr:text-left rtl:text-right">
          {listing.title}
        </h2>
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-2xl font-semibold whitespace-nowrap tabular-nums">{listing.amount}</span>
          {listing.per ? <span className="text-sm text-foreground-muted">{listing.per}</span> : null}
          {listing.negotiable ? <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-foreground-muted">{t("negotiable")}</span> : null}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground-muted">
          {listing.place ? (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-4 shrink-0" aria-hidden="true" />
              {t("approximate", { place: listing.place })}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            {listing.today ? <span aria-hidden="true" className="size-2 rounded-full bg-today" /> : <CalendarDays className="size-4 shrink-0" aria-hidden="true" />}
            <time dateTime={listing.dateTime}>{listing.date}</time>
          </span>
        </p>
        {chips.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("facts")}>
            {chips.map((chip) => (
              <li key={chip} className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium">
                {chip}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <Link href={href} prefetch={false} className="inline-flex min-h-11 items-center gap-1.5 font-medium text-link underline-offset-4 hover:underline" data-testid="search-detail-open">
            <SquareArrowOutUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            {t("open")}
          </Link>
          {listing.example ? null : (
            <Link href={`${href}#signaler`} prefetch={false} className="inline-flex min-h-11 items-center gap-1.5 text-foreground-muted underline-offset-4 hover:text-foreground hover:underline">
              <Flag className="size-4" aria-hidden="true" />
              {t("report")}
            </Link>
          )}
        </div>
      </div>

      {listing.example ? null : (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-4 py-3">
          <Link
            href={`${href}#contact`}
            prefetch={false}
            className={cn(
              "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-primary px-4 font-semibold text-primary-foreground",
              "transition-[background-color,scale] duration-150 ease-door hover:bg-primary-hover active:scale-[0.98]",
            )}
          >
            <MessageCircle className="size-5" aria-hidden="true" />
            {t("contact")}
          </Link>
          <FavoriteButton listingId={listing.id} />
        </div>
      )}
    </section>
  );
}
