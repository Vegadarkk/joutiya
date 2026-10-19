"use client";

import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { useRouter } from "@/i18n/navigation";
import { ApiError, loadSession, useSession } from "@/lib/auth/client";
import { favoritesSnapshot, forgetFavorites, loadFavoriteIds, setFavorite, useFavorites } from "@/lib/favorites/client";
import { cn } from "@/lib/utils";

// The heart of a listing (design D17, D22): a client island on cards (over the photo, `relative
// z-10` above the card's stretched link) and on the listing page. Public pages are static, so the
// heart renders neutral until the session is known; the ids of the account come once per page from
// GET /api/favorites/ids (module store shared by every heart). A click by an anonymous visitor goes
// to sign-in and comes back here.

export interface FavoriteButtonProps {
  listingId: string;
  className?: string;
  /** `overlay` (default): round button over a card photo; `inline`: labelled button (listing page). */
  variant?: "overlay" | "inline";
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function FavoriteButton({ listingId, className, variant = "overlay" }: FavoriteButtonProps) {
  const t = useTranslations("Favorites.button");
  const apiMessage = useApiErrorMessage();
  const router = useRouter();
  const { status, session } = useSession();
  const favorites = useFavorites();
  // Set by a click that added the favorite: plays the confirmation ring once.
  const [burst, setBurst] = useState(0);

  const uid = status === "ready" ? (session?.uid ?? null) : undefined;
  useEffect(() => {
    if (uid) void loadFavoriteIds(uid);
    else if (uid === null) forgetFavorites();
  }, [uid]);

  const known = uid !== undefined && uid !== null && favorites.uid === uid && favorites.status === "ready";
  const active = known && favorites.ids.has(listingId);
  const busy = favorites.busy.has(listingId);

  async function onClick() {
    const viewer = status === "ready" ? session : await loadSession();
    if (!viewer) {
      router.push({ pathname: "/connexion", query: { next: currentPath() } });
      return;
    }
    await loadFavoriteIds(viewer.uid);
    const store = favoritesSnapshot();
    if (store.status !== "ready" || store.uid !== viewer.uid) {
      toast.error(apiMessage(new ApiError(0, "network")));
      return;
    }
    // A request for this listing is in flight: setFavorite would ignore the click, so no ring or
    // "added" toast may claim a change (the ids already show the pending one).
    if (store.busy.has(listingId)) return;
    const next = !store.ids.has(listingId);
    if (next) setBurst((value) => value + 1);
    try {
      await setFavorite(listingId, next);
      if (next) toast.success(t("added"), { action: { label: t("view"), onClick: () => router.push("/favoris") } });
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthenticated") {
        router.push({ pathname: "/connexion", query: { next: currentPath() } });
        return;
      }
      toast.error(apiMessage(error));
    }
  }

  const icon = (
    <span className="relative inline-flex">
      <Heart
        key={active ? "on" : "off"}
        aria-hidden="true"
        strokeWidth={2}
        className={cn(
          "size-5 transition-colors duration-150 ease-door",
          active ? "fill-primary text-primary animate-in zoom-in-50 fade-in-0 duration-300" : "fill-transparent text-current",
        )}
      />
      {burst > 0 && active ? (
        <span
          key={burst}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 rounded-full border-2 border-featured animate-out fade-out-0 zoom-out-150 duration-500 [animation-fill-mode:forwards]"
        />
      ) : null}
    </span>
  );

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={() => void onClick()}
        aria-busy={busy || undefined}
        data-testid="favorite-button"
        data-active={active || undefined}
        className={cn(
          "inline-flex h-11 shrink-0 items-center gap-2 rounded-md border px-4 text-base font-medium",
          "transition-[background-color,border-color,color,scale] duration-150 ease-door active:scale-[0.98]",
          active ? "border-primary/40 bg-ochre-50 text-primary-hover dark:bg-ochre-900/40 dark:text-primary" : "border-border-strong bg-surface text-foreground hover:bg-surface-muted",
          className,
        )}
      >
        {icon}
        <span>{active ? t("saved") : t("add")}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      // A toggle keeps its name; the state is aria-pressed (absent while unknown).
      aria-label={t("label")}
      aria-pressed={known ? active : undefined}
      data-active={active || undefined}
      aria-busy={busy || undefined}
      data-testid="favorite-button"
      className={cn(
        // 44 px target, a 36 px disc: legible over any photo, light or dark.
        "group/fav relative z-10 inline-flex size-11 shrink-0 items-center justify-center rounded-full outline-none",
        // The focus ring hugs the visible disc (not the 44 px target around it), with no gap: the
        // light disc, not the photo, is what it has to stand out from.
        "[&:focus-visible>span]:outline-2 [&:focus-visible>span]:outline-offset-0 [&:focus-visible>span]:outline-ring",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-full bg-surface/90 text-foreground shadow-sm shadow-bab-950/20 backdrop-blur-sm",
          "transition-[background-color,scale] duration-150 ease-door group-hover/fav:bg-surface group-active/fav:scale-90",
        )}
      >
        {icon}
      </span>
    </button>
  );
}
