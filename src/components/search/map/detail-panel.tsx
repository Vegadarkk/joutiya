"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, BadgeCheck, Camera, CalendarDays, Flag, ImageOff, MapPin, MessageCircle, UserRound, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { PriceGuideScale } from "@/components/listing/price-guide-scale";
import { BoostBadge } from "@/components/search/boost-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { listingPreviewPath, type ListingPreview } from "@/lib/contracts/listing-preview";
import { cn } from "@/lib/utils";
import { useSearchMap } from "./search-map-root";

// Detail of a result beside the desktop map (Carte vivante, lot 2): opened by a pin or a row, at the
// end side. At once, what the results card already carries (photo, price, place, date, key facts,
// §8 mentions) and the way to the full page right under it; then the cards of the preview API
// (criteria, description, « Prix repère », seller), fetched per listing and kept for the visit.
// Contact and report stay on the listing page itself. A non-modal dialog: Escape and the close
// button shut it and focus returns to the opener.

/** Main criteria shown in the panel; the rest is on the full page. */
const CRITERIA_MAX = 8;
/** Previews kept per visit (pins opened back and forth answer at once). */
const PREVIEWS_KEPT = 40;
const previews = new Map<string, ListingPreview | null>();

/** The preview of `id`, fetched once per locale; null once it failed (the panel keeps its first part). */
function useListingPreview(id: string | null, locale: string): { preview: ListingPreview | null; loading: boolean } {
  const key = id ? `${locale}:${id}` : "";
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!id || previews.has(key)) return;
    const controller = new AbortController();
    fetch(listingPreviewPath(id, locale), { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => (response.ok ? ((await response.json()) as ListingPreview) : null))
      .catch((error: unknown) => ((error as Error).name === "AbortError" ? undefined : null))
      .then((preview) => {
        if (preview === undefined) return;
        const oldest = previews.size >= PREVIEWS_KEPT ? previews.keys().next().value : undefined;
        if (oldest !== undefined) previews.delete(oldest);
        previews.set(key, preview);
        rerender((count) => count + 1);
      });
    return () => controller.abort();
  }, [id, key, locale]);
  return { preview: previews.get(key) ?? null, loading: Boolean(id) && !previews.has(key) };
}

export function DetailPanel() {
  const t = useTranslations("SearchMap.detail");
  const state = useSearchMap();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const open = state !== null && state.desktop && state.view === "map" && state.canMap ? state.selected : null;
  const listing = open ? state?.listings.find((item) => item.id === open) : undefined;
  const select = state?.select;
  const locale = useLocale();
  const { preview, loading } = useListingPreview(listing?.id ?? null, locale);
  const guideId = useId();

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
  const chips = [...listing.facts, ...(listing.exclusive ? [t("exclusive")] : [])];
  const criteria = preview?.criteria.slice(0, CRITERIA_MAX) ?? [];

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
        <Link
          href={href}
          prefetch={false}
          data-testid="search-detail-open"
          className={cn(
            "group/open mt-1 inline-flex min-h-12 items-center justify-between gap-3 rounded-md bg-structure ps-4 pe-3 font-semibold text-structure-foreground shadow-sm shadow-bab-950/15",
            "transition-[background-color,scale] duration-150 ease-door hover:bg-bab-800 active:scale-[0.99] dark:bg-gold-300 dark:text-bab-950 dark:hover:bg-gold-200",
          )}
        >
          {t("open")}
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-structure-foreground/15 transition-transform dark:bg-bab-950/10 duration-200 ease-door group-hover/open:translate-x-0.5 rtl:group-hover/open:-translate-x-0.5">
            <ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          </span>
        </Link>

        {loading ? (
          <div role="status" data-testid="search-detail-loading" className="flex flex-col gap-3">
            <span className="sr-only">{t("loading")}</span>
            <Skeleton className="h-28 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ) : null}

        {criteria.length > 0 ? (
          <section aria-labelledby={`${guideId}-criteria`} data-testid="search-detail-criteria" className="rounded-lg border border-border bg-surface px-4 pt-3 pb-4">
            <h3 id={`${guideId}-criteria`} className="mb-3 text-sm font-semibold">
              {t("criteria")}
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              {criteria.map((row) => (
                <div key={row.id} className="flex min-w-0 flex-col gap-0.5 border-s-2 border-border ps-2.5">
                  <dt className="text-xs text-foreground-muted">{row.label}</dt>
                  <dd dir={row.userText ? "auto" : undefined} className="text-sm font-medium break-words">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {preview?.description ? (
          <section aria-labelledby={`${guideId}-description`} data-testid="search-detail-description" className="rounded-lg border border-border bg-surface px-4 pt-3 pb-3.5">
            <h3 id={`${guideId}-description`} className="mb-1.5 text-sm font-semibold">
              {t("description")}
            </h3>
            <p dir="auto" className="line-clamp-5 text-sm leading-relaxed whitespace-pre-line text-foreground-muted">
              {preview.description}
            </p>
            <Link href={href} prefetch={false} tabIndex={-1} className="mt-1.5 inline-block text-sm font-medium text-link underline-offset-4 hover:underline">
              {t("readMore")}
            </Link>
          </section>
        ) : null}

        {preview?.guide ? <PriceGuideScale view={preview.guide} titleId={`${guideId}-guide`} /> : null}

        {listing.example ? null : (
          <section aria-labelledby={`${guideId}-seller`} data-testid="search-detail-seller" className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
              {listing.pro ? <BadgeCheck className="size-5" aria-hidden="true" /> : <UserRound className="size-5" aria-hidden="true" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h3 id={`${guideId}-seller`} className="text-xs text-foreground-muted">
                {t("seller")}
              </h3>
              <p className="text-sm font-semibold">{listing.pro ? t("pro") : t("individual")}</p>
            </div>
            {preview?.seller ? (
              <Link href={`/profil/${preview.seller.publicId}`} prefetch={false} className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-link underline-offset-4 hover:underline">
                {t("profile")}
              </Link>
            ) : null}
          </section>
        )}

        {listing.example ? null : (
          <Link href={`${href}#signaler`} prefetch={false} className="inline-flex min-h-11 items-center gap-1.5 self-end text-sm text-foreground-muted underline-offset-4 hover:text-foreground hover:underline">
            <Flag className="size-4" aria-hidden="true" />
            {t("report")}
          </Link>
        )}
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
