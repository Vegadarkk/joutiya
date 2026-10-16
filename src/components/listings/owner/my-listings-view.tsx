"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { usePublicConfig } from "@/lib/config/client";
import { OWNER_LIST_BUCKETS, type OwnerListBucket, type OwnerListingSummary } from "@/lib/contracts/listings";
import { deleteListing, listMine, listingAction, type OwnerAction } from "@/lib/listings/client/api";
import { cn } from "@/lib/utils";
import { OwnerListingCard } from "./owner-listing-card";

// /mes-annonces: four tabs over GET /api/listings/mine?status=..., one list per bucket (cached per
// visit), actions per status with confirmation for the irreversible ones.

type Bucket = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; listings: OwnerListingSummary[] };

const TOAST_KEY: Record<OwnerAction, "paused" | "resumed" | "sold" | "renewed"> = { pause: "paused", resume: "resumed", sold: "sold", renew: "renewed" };

function isBucket(value: string | null): value is OwnerListBucket {
  return value !== null && (OWNER_LIST_BUCKETS as readonly string[]).includes(value);
}

export function MyListingsView() {
  const t = useTranslations("MyListings");
  const apiMessage = useApiErrorMessage();
  const config = usePublicConfig();
  const params = useSearchParams();
  const initial = params.get("onglet");
  const [tab, setTab] = useState<OwnerListBucket>(isBucket(initial) ? initial : "active");
  const [buckets, setBuckets] = useState<Partial<Record<OwnerListBucket, Bucket>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  // An absent bucket is a loading one; `load` only records the answer.
  const load = useCallback(async (bucket: OwnerListBucket) => {
    try {
      const { listings } = await listMine(bucket);
      setBuckets((current) => ({ ...current, [bucket]: { kind: "ready", listings } }));
    } catch (error) {
      setBuckets((current) => ({ ...current, [bucket]: { kind: "failed", error } }));
    }
  }, []);

  useEffect(() => {
    if (!buckets[tab]) void load(tab);
  }, [tab, buckets, load]);

  function selectTab(next: OwnerListBucket) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("onglet", next);
    window.history.replaceState(null, "", url.toString());
  }

  /** After a mutation every bucket is stale: drop them, reload the visible one. */
  const invalidate = useCallback(() => {
    setBuckets({});
  }, []);

  const current = buckets[tab] ?? { kind: "loading" };
  const mediaBaseUrl = config?.mediaBaseUrl ?? null;

  const onAction = useCallback(
    async (id: string, action: OwnerAction) => {
      setBusyId(id);
      try {
        await listingAction(id, action);
        toast.success(t(`toasts.${TOAST_KEY[action]}`));
        invalidate();
      } catch (error) {
        toast.error(apiMessage(error));
      } finally {
        setBusyId(null);
      }
    },
    [apiMessage, invalidate, t],
  );

  const onDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await deleteListing(id);
        toast.success(t("toasts.deleted"));
        setBuckets((state) => {
          const bucket = state[tab];
          return bucket?.kind === "ready" ? { ...state, [tab]: { kind: "ready", listings: bucket.listings.filter((item) => item.id !== id) } } : state;
        });
      } catch (error) {
        toast.error(apiMessage(error));
      } finally {
        setBusyId(null);
      }
    },
    [apiMessage, t, tab],
  );

  const tabs = useMemo(() => OWNER_LIST_BUCKETS.map((bucket) => ({ bucket, label: t(`tabs.${bucket}`) })), [t]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        </div>
        <Button asChild>
          <Link href={{ pathname: "/deposer", query: { nouveau: "1" } }}>{t("post")}</Link>
        </Button>
      </header>

      <div role="tablist" aria-label={t("tabsLabel")} className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
        {tabs.map(({ bucket, label }) => {
          const selected = bucket === tab;
          const count = buckets[bucket]?.kind === "ready" ? (buckets[bucket] as Extract<Bucket, { kind: "ready" }>).listings.length : null;
          return (
            <button
              key={bucket}
              role="tab"
              type="button"
              id={`tab-${bucket}`}
              aria-selected={selected}
              aria-controls={`panel-${bucket}`}
              onClick={() => selectTab(bucket)}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors duration-150 ease-door",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
                selected ? "border-featured text-foreground" : "border-transparent text-foreground-muted hover:text-foreground",
              )}
            >
              {label}
              {count !== null ? <span className="rounded-full bg-surface-muted px-1.5 text-xs tabular-nums text-foreground-muted">{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-40">
        {current.kind === "loading" ? (
          <ul role="status" aria-busy="true" className="flex flex-col divide-y divide-border">
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
                <Link href={{ pathname: "/deposer", query: { nouveau: "1" } }}>{t("post")}</Link>
              </Button>
            }
          >
            {t(`empty.${tab}Body`)}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-busy={busyId !== null || undefined}>
            {current.listings.map((listing) => (
              <OwnerListingCard key={listing.id} listing={listing} mediaBaseUrl={mediaBaseUrl} onAction={(action) => onAction(listing.id, action)} onDelete={() => onDelete(listing.id)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
