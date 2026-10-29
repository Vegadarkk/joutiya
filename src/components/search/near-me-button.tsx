"use client";

import { useState } from "react";
import { LocateFixed } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { MOROCCO_BBOX } from "@/config/regions";
import { normalizeZone, type SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { searchLinkHref } from "./filter-model";
import { useSearchNavigation } from "./search-navigation";

// « Utiliser ma position » of an understood « près de moi » (Carte vivante, lot 4). The browser is
// asked for its position only on this click; the point becomes the search's `zone` (centre rounded
// to ~110 m like every map zone, the radius asked) marked `position=1` (« À N km de vous »), part of
// the search URL and nothing else: it is sent nowhere else and stored nowhere. Outside Morocco, denied or unavailable: a message and the
// filters' city instead.

type Status = "idle" | "locating" | "denied" | "unavailable" | "outside";

function inMorocco(lat: number, lng: number): boolean {
  return lat >= MOROCCO_BBOX.south && lat <= MOROCCO_BBOX.north && lng >= MOROCCO_BBOX.west && lng <= MOROCCO_BBOX.east;
}

export function NearMeButton({ target, km, className }: { target: SearchParams; km: number; className?: string }) {
  const t = useTranslations("SearchInterpret");
  const navigation = useSearchNavigation();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");

  function locate() {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unavailable");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (!inMorocco(coords.latitude, coords.longitude)) {
          setStatus("outside");
          return;
        }
        const zone = normalizeZone({ lat: coords.latitude, lng: coords.longitude, km });
        if (!zone) {
          setStatus("unavailable");
          return;
        }
        const next: SearchParams = { ...target, zone, fromPosition: true, page: undefined };
        if (navigation) navigation.navigate(next, { scroll: false });
        else router.push(searchLinkHref(next), { scroll: false });
      },
      (error) => setStatus(error.code === error.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  const failed = status === "denied" || status === "unavailable" || status === "outside";
  return (
    <>
      <button
        type="button"
        onClick={locate}
        disabled={status === "locating"}
        aria-describedby="near-me-privacy"
        data-testid="near-me"
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-structure/40 bg-surface ps-3 pe-3.5 text-sm font-medium text-foreground sm:min-h-9",
          "transition-[background-color,border-color,scale] duration-150 ease-door hover:border-structure hover:bg-surface-brand active:scale-[0.98] disabled:opacity-70",
          className,
        )}
      >
        <LocateFixed className={cn("size-4 shrink-0 text-structure dark:text-bab-200", status === "locating" && "motion-safe:animate-pulse")} aria-hidden="true" />
        {status === "locating" ? t("locating") : t("useLocation")}
      </button>
      <p id="near-me-privacy" className="order-last w-full text-xs text-pretty text-foreground-muted">
        {t("privacy")}
      </p>
      {failed ? (
        <p role="status" className="order-last w-full text-sm text-pretty text-danger">
          {t(`errors.${status}`)}
        </p>
      ) : null}
    </>
  );
}
