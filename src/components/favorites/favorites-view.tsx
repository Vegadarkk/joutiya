"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { ListingGridSkeleton } from "@/components/feedback/skeletons";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { usePublicConfig } from "@/lib/config/client";
import { FAVORITES_MAX, type FavoriteView } from "@/lib/contracts/search";
import { listFavorites, setFavorite } from "@/lib/favorites/client";
import { cn } from "@/lib/utils";
import { FavoriteCard } from "./favorite-card";

// "Mes favoris" (design D17): GET /api/favorites, 48 per page (cursor), newest first. Removing
// takes the card away at once (the hearts of other tabs follow the shared store) with an undo
// while the listing is still online.

type View =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "ready"; favorites: FavoriteView[]; next?: string; total: number; more: "idle" | "loading" | "failed" };

export function FavoritesView() {
  const t = useTranslations("Favorites.page");
  const locale = useLocale() as Locale;
  const apiMessage = useApiErrorMessage();
  const config = usePublicConfig();
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
      setView((current) => {
        if (current.kind !== "ready") return current;
        const known = new Set(current.favorites.map((item) => item.listingId));
        return { kind: "ready", favorites: [...current.favorites, ...page.favorites.filter((item) => !known.has(item.listingId))], next: page.next, total: page.total, more: "idle" };
      });
    } catch (error) {
      setView((current) => (current.kind === "ready" ? { ...current, more: "failed" } : current));
      toast.error(apiMessage(error));
    }
  }

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

  const browse = (
    <Button asChild>
      <Link href="/recherche">{t("browse")}</Link>
    </Button>
  );

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
      ) : view.favorites.length === 0 ? (
        <EmptyState title={t("emptyTitle")} action={browse}>
          {t("emptyBody")}
        </EmptyState>
      ) : (
        <>
          <ul className={cn("grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4")} data-testid="favorites-grid">
            {view.favorites.map((favorite) => (
              <li key={favorite.listingId} className="min-w-0">
                <FavoriteCard
                  favorite={favorite}
                  mediaBaseUrl={config?.mediaBaseUrl ?? null}
                  locale={locale}
                  busy={busy.has(favorite.listingId)}
                  onRemove={() => void remove(favorite)}
                />
              </li>
            ))}
          </ul>
          {view.next ? (
            <div className="flex justify-center">
              <Button type="button" variant="outline" loading={view.more === "loading"} onClick={() => void loadMore()}>
                {view.more === "failed" ? t("retry") : t("more")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
