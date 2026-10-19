"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { ListingGridSkeleton } from "@/components/feedback/skeletons";
import { RESULTS_GRID_CLASS } from "@/components/search/grid";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { usePublicConfig } from "@/lib/config/client";
import { FAVORITES_MAX, type FavoritesPage, type FavoriteView } from "@/lib/contracts/search";
import { listFavorites, setFavorite } from "@/lib/favorites/client";
import { FavoriteCard } from "./favorite-card";

// "Mes favoris" (design D17): GET /api/favorites, 48 per page (cursor), newest first. Removing
// takes the card away at once (the hearts of other tabs follow the shared store) with an undo
// while the listing is still online.

/** The loaded pages: `next` is the cursor of the following one. */
export interface FavoritesList {
  favorites: FavoriteView[];
  next?: string;
  more: "idle" | "loading" | "failed";
}

type View = { kind: "loading" } | { kind: "failed"; error: unknown } | ({ kind: "ready"; total: number } & FavoritesList);

/** Appends a later page to the ready list (a listing already shown is not repeated). */
function withPage(current: View, page: FavoritesPage): View {
  if (current.kind !== "ready") return current;
  const known = new Set(current.favorites.map((item) => item.listingId));
  return { kind: "ready", favorites: [...current.favorites, ...page.favorites.filter((item) => !known.has(item.listingId))], next: page.next, total: page.total, more: "idle" };
}

/**
 * The cards in the search results grid, or the empty state once nothing is left to load. Removals
 * can empty the loaded cards while later pages remain: the next page loads in their place.
 */
export function FavoritesGrid({
  list,
  busy,
  onRemove,
  onMore,
}: {
  list: FavoritesList;
  busy: ReadonlySet<string>;
  onRemove: (favorite: FavoriteView) => void;
  onMore: () => void;
}) {
  const t = useTranslations("Favorites.page");
  const locale = useLocale() as Locale;
  const config = usePublicConfig();

  if (list.favorites.length === 0 && !list.next) {
    return (
      <EmptyState
        title={t("emptyTitle")}
        action={
          <Button asChild>
            <Link href="/recherche">{t("browse")}</Link>
          </Button>
        }
      >
        {t("emptyBody")}
      </EmptyState>
    );
  }
  const refilling = list.favorites.length === 0 && list.more !== "failed";
  return (
    <>
      {refilling ? (
        <div aria-label={t("loading")}>
          <ListingGridSkeleton count={4} />
        </div>
      ) : list.favorites.length > 0 ? (
        <ul className={RESULTS_GRID_CLASS} data-testid="favorites-grid">
          {list.favorites.map((favorite) => (
            <li key={favorite.listingId} className="min-w-0">
              <FavoriteCard favorite={favorite} mediaBaseUrl={config?.mediaBaseUrl ?? null} locale={locale} busy={busy.has(favorite.listingId)} onRemove={() => onRemove(favorite)} />
            </li>
          ))}
        </ul>
      ) : null}
      {list.next && !refilling ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" loading={list.more === "loading"} onClick={onMore}>
            {list.more === "failed" ? t("retry") : t("more")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function FavoritesView() {
  const t = useTranslations("Favorites.page");
  const apiMessage = useApiErrorMessage();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Bumped by retry(): the effect loads the first page again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    listFavorites().then(
      (page) => {
        if (current) setView({ kind: "ready", favorites: page.favorites, next: page.next, total: page.total, more: "idle" });
      },
      (error: unknown) => {
        if (current) setView({ kind: "failed", error });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  function retry() {
    setView({ kind: "loading" });
    setAttempt((value) => value + 1);
  }

  async function loadMore() {
    if (view.kind !== "ready" || !view.next || view.more === "loading") return;
    const cursor = view.next;
    setView({ ...view, more: "loading" });
    try {
      const page = await listFavorites(cursor);
      setView((current) => withPage(current, page));
    } catch (error) {
      setView((current) => (current.kind === "ready" ? { ...current, more: "failed" } : current));
      toast.error(apiMessage(error));
    }
  }

  // Every loaded card was removed while later pages remain: the next page takes their place
  // (FavoritesGrid shows a skeleton meanwhile, the "more" button again if it fails).
  const refill = view.kind === "ready" && view.favorites.length === 0 && view.more === "idle" ? view.next : undefined;
  useEffect(() => {
    if (!refill) return;
    let current = true;
    listFavorites(refill).then(
      (page) => {
        if (current) setView((value) => withPage(value, page));
      },
      (error: unknown) => {
        if (!current) return;
        setView((value) => (value.kind === "ready" ? { ...value, more: "failed" } : value));
        toast.error(apiMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, [refill, apiMessage]);

  function markBusy(listingId: string, value: boolean) {
    setBusy((current) => {
      const next = new Set(current);
      if (value) next.add(listingId);
      else next.delete(listingId);
      return next;
    });
  }

  async function restore(favorite: FavoriteView, index: number) {
    try {
      await setFavorite(favorite.listingId, true);
      setView((current) => {
        if (current.kind !== "ready" || current.favorites.some((item) => item.listingId === favorite.listingId)) return current;
        const favorites = [...current.favorites];
        favorites.splice(Math.min(index, favorites.length), 0, favorite);
        return { ...current, favorites, total: current.total + 1 };
      });
    } catch (error) {
      toast.error(apiMessage(error));
    }
  }

  async function remove(favorite: FavoriteView) {
    if (view.kind !== "ready") return;
    const index = view.favorites.findIndex((item) => item.listingId === favorite.listingId);
    markBusy(favorite.listingId, true);
    try {
      await setFavorite(favorite.listingId, false);
      setView((current) =>
        current.kind === "ready" ? { ...current, favorites: current.favorites.filter((item) => item.listingId !== favorite.listingId), total: Math.max(0, current.total - 1) } : current,
      );
      toast.success(t("removed"), favorite.available ? { action: { label: t("undo"), onClick: () => void restore(favorite, index) } } : undefined);
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      markBusy(favorite.listingId, false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        {view.kind === "ready" && view.total > 0 ? (
          <p className="text-sm text-foreground-muted tabular-nums" data-testid="favorites-count">
            {t("count", { count: view.total, max: FAVORITES_MAX })}
          </p>
        ) : null}
      </header>

      {view.kind === "loading" ? (
        <div aria-label={t("loading")}>
          <ListingGridSkeleton count={8} />
        </div>
      ) : view.kind === "failed" ? (
        <FormMessage
          error={view.error}
          title={t("loadFailedTitle")}
          action={
            <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={retry}>
              {t("retry")}
            </Button>
          }
        >
          {apiMessage(view.error)}
        </FormMessage>
      ) : (
        <FavoritesGrid list={view} busy={busy} onRemove={(favorite) => void remove(favorite)} onMore={() => void loadMore()} />
      )}
    </div>
  );
}
