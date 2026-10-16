"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isRtl, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { usePublicConfig } from "@/lib/config/client";
import { MAX_DRAFTS, OWNER_LIST_BUCKETS, type OwnerListBucket, type OwnerListing, type OwnerListingSummary } from "@/lib/contracts/listings";
import { deleteListing, listMine, listingAction, type OwnerAction } from "@/lib/listings/client/api";
import { cn } from "@/lib/utils";
import { BUCKET_STATUSES, tabKeyTarget, visibleListings } from "./buckets";
import { OwnerListingCard } from "./owner-listing-card";

// /mes-annonces: four tabs over GET /api/listings/mine?status=..., one list per bucket (cached per
// visit). After an action the row changes at once (the API answers with the listing), the visible
// tab reloads behind the list and the other tabs reload when opened.

type Bucket = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; listings: OwnerListingSummary[]; refreshing?: boolean };

const TOAST_KEY: Record<OwnerAction, "paused" | "resumed" | "sold" | "renewed"> = { pause: "paused", resume: "resumed", sold: "sold", renew: "renewed" };

function isBucket(value: string | null): value is OwnerListBucket {
  return value !== null && (OWNER_LIST_BUCKETS as readonly string[]).includes(value);
}

/** The row after an action, from the listing the API answered with (renewability comes with the reload). */
function summaryAfter(summary: OwnerListingSummary, listing: OwnerListing): OwnerListingSummary {
  return {
    ...summary,
    status: listing.status,
    slugId: listing.slugId,
    updatedAt: listing.updatedAt,
    publishedAt: listing.publishedAt,
    expiresAt: listing.expiresAt,
    canRenew: false,
  };
}

export function MyListingsView() {
  const t = useTranslations("MyListings");
  const locale = useLocale() as Locale;
  const rtl = isRtl(locale);
  const apiMessage = useApiErrorMessage();
  const config = usePublicConfig();
  const params = useSearchParams();
  const initial = params.get("onglet");
  const [tab, setTab] = useState<OwnerListBucket>(isBucket(initial) ? initial : "active");
  const [buckets, setBuckets] = useState<Partial<Record<OwnerListBucket, Bucket>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Answers that arrive out of order: only the latest request of a bucket is kept.
  const requests = useRef<Partial<Record<OwnerListBucket, number>>>({});
  const tabRefs = useRef<Partial<Record<OwnerListBucket, HTMLButtonElement | null>>>({});

  const load = useCallback(async (bucket: OwnerListBucket) => {
    const request = (requests.current[bucket] ?? 0) + 1;
    requests.current[bucket] = request;
    try {
      const { listings } = await listMine(bucket);
      if (requests.current[bucket] !== request) return;
      setBuckets((current) => ({ ...current, [bucket]: { kind: "ready", listings: visibleListings(bucket, listings) } }));
    } catch (error) {
      if (requests.current[bucket] !== request) return;
      // A reload behind a list keeps the list; only a first load shows the error.
      setBuckets((current) => {
        const shown = current[bucket];
        return { ...current, [bucket]: shown?.kind === "ready" ? { ...shown, refreshing: false } : { kind: "failed", error } };
      });
    }
  }, []);

  // An absent bucket is a loading one: the effect starts its request.
  useEffect(() => {
    if (!buckets[tab]) void load(tab);
  }, [tab, buckets, load]);

  function selectTab(next: OwnerListBucket, focus = false) {
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
    const url = new URL(window.location.href);
    url.searchParams.set("onglet", next);
    window.history.replaceState(window.history.state, "", url.toString());
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = tabKeyTarget(event.key, index, OWNER_LIST_BUCKETS.length, rtl);
    if (target === null) return;
    event.preventDefault();
    selectTab(OWNER_LIST_BUCKETS[target]!, true);
  }

  /** Every bucket may have changed: the visible one reloads behind its list, the others when opened. */
  const refresh = useCallback(
    (bucket: OwnerListBucket, rows?: (listings: OwnerListingSummary[]) => OwnerListingSummary[]) => {
      setBuckets((current) => {
        const shown = current[bucket];
        return shown?.kind === "ready" ? { [bucket]: { kind: "ready", listings: rows ? rows(shown.listings) : shown.listings, refreshing: true } } : {};
      });
      void load(bucket);
    },
    [load],
  );

  const onAction = useCallback(
    async (id: string, action: OwnerAction) => {
      setBusyId(id);
      try {
        const { listing } = await listingAction(id, action);
        toast.success(t(`toasts.${TOAST_KEY[action]}`));
        // The row changes now; a listing that left the tab (sold) leaves the list.
        refresh(tab, (listings) =>
          listings.flatMap((item) => {
            if (item.id !== id) return [item];
            return BUCKET_STATUSES[tab].includes(listing.status) ? [summaryAfter(item, listing)] : [];
          }),
        );
      } catch (error) {
        toast.error(apiMessage(error));
      } finally {
        setBusyId(null);
      }
    },
    [apiMessage, refresh, t, tab],
  );

  const onDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await deleteListing(id);
        toast.success(t("toasts.deleted"));
        refresh(tab, (listings) => listings.filter((item) => item.id !== id));
      } catch (error) {
        toast.error(apiMessage(error));
      } finally {
        setBusyId(null);
      }
    },
    [apiMessage, refresh, t, tab],
  );

  const tabs = useMemo(() => OWNER_LIST_BUCKETS.map((bucket) => ({ bucket, label: t(`tabs.${bucket}`) })), [t]);
  const current = buckets[tab] ?? { kind: "loading" };
  const mediaBaseUrl = config?.mediaBaseUrl ?? null;
  const newListing = { pathname: "/deposer", query: { nouveau: "1" } } as const;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        </div>
        <Button asChild>
          <Link href={newListing}>{t("post")}</Link>
        </Button>
      </header>

      <div role="tablist" aria-label={t("tabsLabel")} className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        {tabs.map(({ bucket, label }, index) => {
          const selected = bucket === tab;
          const shown = buckets[bucket];
          const count = shown?.kind === "ready" ? shown.listings.length : null;
          return (
            <button
              key={bucket}
              ref={(element) => {
                tabRefs.current[bucket] = element;
              }}
              role="tab"
              type="button"
              id={`tab-${bucket}`}
              aria-selected={selected}
              aria-controls={`panel-${bucket}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(bucket)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={cn(
                "relative flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors duration-150 ease-door",
                "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-[background-color,transform] after:duration-200 after:ease-door",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
                selected ? "text-foreground after:scale-x-100 after:bg-featured" : "text-foreground-muted after:scale-x-0 after:bg-transparent hover:text-foreground",
              )}
            >
              {label}
              {count !== null ? (
                <span className={cn("min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums", selected ? "bg-featured/15 text-foreground" : "bg-surface-muted text-foreground-muted")}>{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-40">
        {current.kind === "loading" ? (
          <ul role="status" aria-busy="true" aria-label={t("loading")} className="flex flex-col divide-y divide-border">
            {Array.from({ length: 3 }, (_, index) => (
              <li key={index} className="flex gap-4 py-4">
                <Skeleton className="aspect-[4/3] w-28 rounded-lg sm:w-36" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </li>
            ))}
          </ul>
        ) : current.kind === "failed" ? (
          <FormMessage
            error={current.error}
            title={t("loadFailedTitle")}
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => setBuckets((state) => ({ ...state, [tab]: undefined }))}>
                {t("retry")}
              </Button>
            }
          >
            {apiMessage(current.error)}
          </FormMessage>
        ) : current.listings.length === 0 ? (
          <EmptyState
            title={t(`empty.${tab}Title`)}
            action={
              <Button asChild>
                <Link href={newListing}>{t("post")}</Link>
              </Button>
            }
          >
            {t(`empty.${tab}Body`)}
          </EmptyState>
        ) : (
          <>
            {tab === "drafts" ? <p className="mb-1 text-sm text-foreground-muted">{t("draftsLimit", { count: current.listings.length, max: MAX_DRAFTS })}</p> : null}
            <ul className={cn("flex flex-col divide-y divide-border transition-opacity duration-200", current.refreshing && "opacity-80")} aria-busy={busyId !== null || current.refreshing || undefined}>
              {current.listings.map((listing) => (
                <OwnerListingCard key={listing.id} listing={listing} mediaBaseUrl={mediaBaseUrl} busy={busyId === listing.id} onAction={(action) => onAction(listing.id, action)} onDelete={() => onDelete(listing.id)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
