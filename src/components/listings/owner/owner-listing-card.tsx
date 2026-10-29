"use client";

import { ImageOff, Pencil, Play, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Button } from "@/components/ui/button";
import { OwnerAvailability } from "@/components/rental/owner-availability";
import { quietLinkClassName } from "@/components/ui/text-link";
import { Link, getPathname } from "@/i18n/navigation";
import type { OwnerListingSummary } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import type { OwnerAction } from "@/lib/listings/client/api";
import { blurhashDataUrl } from "@/lib/listings/client/blurhash";
import { daysUntil, formatPrice, formatRelativeDays } from "@/lib/listings/client/format";
import { photoUrl } from "@/lib/listings/client/photo-url";
import { wizardPath } from "@/lib/listings/client/routes";
import { cn } from "@/lib/utils";
import { primaryAction } from "./buckets";
import { ListingActions } from "./listing-actions";
import { OwnerPromo, showsPromo } from "./owner-promo";
import { OwnerStock } from "./owner-stock";
import { ListingStatusBadge } from "./status-badge";

/** Statuses whose stock the Pro sets from the list (the read-only ones have none to keep up). */
const STOCK_STATUSES: readonly OwnerListingSummary["status"][] = ["published", "paused", "pending_review", "expired"];

interface OwnerListingCardProps {
  listing: OwnerListingSummary;
  mediaBaseUrl: string | null;
  onAction: (action: OwnerAction) => Promise<void>;
  onDelete: () => Promise<void>;
  /** An action of this row is running. */
  busy?: boolean;
  salesOpen?: boolean;
  now?: Date;
  /** The row after a change made in place (a promotion set or stopped). */
  onChanged?: (listing: OwnerListingSummary) => void;
}

/**
 * One row of "Mes annonces": cover, title, price, city, status, expiry, actions. On phones the
 * primary action takes the full row under the cover (its label is longer than the text column).
 */
export function OwnerListingCard({ listing, mediaBaseUrl, onAction, onDelete, busy = false, salesOpen = false, now = new Date(), onChanged }: OwnerListingCardProps) {
  const t = useTranslations("MyListings");
  const locale = useLocale() as Locale;
  const city = listing.citySlug ? cityBySlug(listing.citySlug) : undefined;
  const thumb = listing.thumb ? photoUrl(mediaBaseUrl, listing.id, listing.thumb.id, "s") : null;
  const placeholder = blurhashDataUrl(listing.thumb?.blurhash);
  const title = listing.title || t("untitled");
  // Inside translated labels the seller's title keeps its own direction (French title, Arabic UI).
  const named = { title: isolate(title) };
  const href = listing.status === "published" && listing.slugId ? null : wizardPath(listing.id);
  // The public page is a full page load (public pages have their own CSP), in the language on screen.
  const publicHref = listing.slugId ? getPathname({ href: `/annonce/${listing.slugId}`, locale }) : null;
  const primary = primaryAction(listing, now);
  const expiry = listing.expiresAt ? daysUntil(new Date(listing.expiresAt), now) : null;
  const price = listing.isDonation ? t("donation") : listing.price !== null ? formatPrice(listing.price, locale) : t("toDiscuss");

  return (
    <li className="grid grid-cols-[7rem_minmax(0,1fr)] grid-rows-[auto_1fr] gap-x-3 py-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
      <div className="relative aspect-[4/3] self-start overflow-hidden rounded-lg bg-surface-muted sm:row-span-2">
        {placeholder ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={placeholder} alt="" aria-hidden="true" className="absolute inset-0 size-full object-cover" />
        ) : null}
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={t("photoAlt", named)} width={listing.thumb?.w} height={listing.thumb?.h} loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
        ) : (
          <span role="img" aria-label={t("noPhoto")} className="absolute inset-0 flex items-center justify-center text-foreground-muted">
            <ImageOff className="size-6" aria-hidden="true" strokeWidth={1.5} />
          </span>
        )}
        {listing.photoCount > 1 ? <span className="absolute bottom-1.5 end-1.5 rounded-sm bg-bab-950/70 px-1.5 py-0.5 text-xs text-cream-100 tabular-nums">{listing.photoCount}</span> : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 text-base font-semibold leading-snug">
            {href ? (
              <Link href={href} dir="auto" className={cn("line-clamp-2 break-words rounded-sm", quietLinkClassName)}>
                {title}
              </Link>
            ) : (
              <a href={publicHref ?? undefined} dir="auto" className={cn("line-clamp-2 break-words rounded-sm", quietLinkClassName)}>
                {title}
              </a>
            )}
          </h2>
          <ListingActions listing={listing} onAction={onAction} onDelete={onDelete} busy={busy} publicHref={publicHref} salesOpen={salesOpen} now={now} />
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
        {listing.rental ? <OwnerAvailability listingId={listing.id} title={title} rental={listing.rental} now={now} /> : null}
        {listing.catalogue && STOCK_STATUSES.includes(listing.status) ? <OwnerStock listingId={listing.id} title={title} catalogue={listing.catalogue} /> : null}
        {listing.catalogue && onChanged && showsPromo(listing) ? <OwnerPromo listing={{ ...listing, catalogue: listing.catalogue }} title={title} now={now} onChanged={onChanged} /> : null}
      </div>
      {primary ? (
        <div className="col-span-2 mt-3 flex min-w-0 sm:col-span-1 sm:col-start-2 sm:mt-2">
          {/* Accessible names start with the visible label (WCAG 2.5.3), then the title. */}
          {primary.kind === "continue" || primary.kind === "fix" ? (
            <Button asChild variant="outline" size="sm" className="max-sm:h-11">
              <Link href={wizardPath(listing.id)} aria-label={t(primary.kind === "continue" ? "actions.continueDraftOf" : "actions.editOf", named)}>
                <Pencil aria-hidden="true" />
                {primary.kind === "continue" ? t("actions.continueDraft") : t("actions.edit")}
              </Link>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-sm:h-11"
              disabled={busy}
              aria-label={t(primary.kind === "resume" ? "actions.resumeOf" : "actions.renewOf", named)}
              onClick={() => void onAction(primary.kind)}
            >
              {primary.kind === "resume" ? <Play aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {primary.kind === "resume" ? t("actions.resume") : t("actions.renew")}
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
