"use client";

import { ImageOff } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import type { OwnerListingSummary } from "@/lib/contracts/listings";
import type { OwnerAction } from "@/lib/listings/client/api";
import { blurhashDataUrl } from "@/lib/listings/client/blurhash";
import { daysUntil, formatPrice, formatRelativeDays } from "@/lib/listings/client/format";
import { photoUrl } from "@/lib/listings/client/photo-url";
import { wizardPath } from "@/lib/listings/client/routes";
import { cn } from "@/lib/utils";
import { ListingActions } from "./listing-actions";
import { ListingStatusBadge } from "./status-badge";

interface OwnerListingCardProps {
  listing: OwnerListingSummary;
  mediaBaseUrl: string | null;
  onAction: (action: OwnerAction) => Promise<void>;
  onDelete: () => Promise<void>;
  now?: Date;
}

/** One row of "Mes annonces": cover, title, price, city, status, expiry, actions. */
export function OwnerListingCard({ listing, mediaBaseUrl, onAction, onDelete, now = new Date() }: OwnerListingCardProps) {
  const t = useTranslations("MyListings");
  const locale = useLocale() as Locale;
  const city = listing.citySlug ? cityBySlug(listing.citySlug) : undefined;
  const thumb = listing.thumb ? photoUrl(mediaBaseUrl, listing.id, listing.thumb.id, "s") : null;
  const placeholder = blurhashDataUrl(listing.thumb?.blurhash);
  const title = listing.title || t("untitled");
  const href = listing.status === "published" && listing.slugId ? null : wizardPath(listing.id);
  const expiry = listing.expiresAt ? daysUntil(new Date(listing.expiresAt), now) : null;
  const price = listing.isDonation ? t("donation") : listing.price !== null ? formatPrice(listing.price, locale) : t("toDiscuss");

  return (
    <li className="flex gap-3 py-4 sm:gap-4">
      <div className="relative aspect-[4/3] w-28 shrink-0 overflow-hidden rounded-lg bg-surface-muted sm:w-36">
        {placeholder ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={placeholder} alt="" aria-hidden="true" className="absolute inset-0 size-full object-cover" />
        ) : null}
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={t("photoAlt", { title })} width={listing.thumb?.w} height={listing.thumb?.h} loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-foreground-muted" aria-label={t("noPhoto")}>
            <ImageOff className="size-6" aria-hidden="true" strokeWidth={1.5} />
          </span>
        )}
        {listing.photoCount > 1 ? <span className="absolute bottom-1.5 end-1.5 rounded-sm bg-bab-950/70 px-1.5 py-0.5 text-xs text-cream-100 tabular-nums">{listing.photoCount}</span> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-base font-semibold leading-snug">
            {href ? (
              <Link href={href} className="line-clamp-2 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">
                {title}
              </Link>
            ) : (
              <a href={`/annonce/${listing.slugId}`} className="line-clamp-2 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">
                {title}
              </a>
            )}
          </h3>
          <ListingActions listing={listing} onAction={onAction} onDelete={onDelete} />
        </div>
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold tabular-nums">{price}</span>
          {city ? <span className="text-foreground-muted">{cityName(city, locale)}</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          <ListingStatusBadge status={listing.status} />
          {expiry !== null && (listing.status === "published" || listing.status === "paused" || listing.status === "expired") ? (
            <span className={cn(expiry <= 7 && expiry >= 0 && "text-warning", expiry < 0 && "text-foreground-muted")}>
              {expiry === 0 ? t("expires.today") : expiry > 0 ? t("expires.in", { relative: formatRelativeDays(expiry, locale) }) : t("expires.past", { relative: formatRelativeDays(expiry, locale) })}
            </span>
          ) : (
            <span>{t("updated", { relative: formatRelativeDays(daysUntil(new Date(listing.updatedAt), now), locale) })}</span>
          )}
          {listing.canRenew ? <span className="font-medium text-structure">{t("expires.renewable")}</span> : null}
        </div>
        {listing.status === "pending_review" ? <p className="text-xs text-foreground-muted text-pretty">{t("pending.body")}</p> : null}
        {listing.status === "rejected" ? <p className="text-xs text-danger text-pretty">{t("rejected.body")}</p> : null}
      </div>
    </li>
  );
}
