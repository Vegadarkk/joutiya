"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Map as MapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { KhatamLoader } from "@/components/ui/khatam-loader";
import { usePublicConfig } from "@/lib/config/client";
import { supportsWebGL2 } from "@/lib/map/webgl";
import { cn } from "@/lib/utils";

// Progressive map of the listing page (D10): the server-rendered static map (children) is always shown;
// when `publicConfig.map` is set and the browser has WebGL2, a button loads the MapLibre island on demand
// (next/dynamic with ssr:false, allowed here because this is a Client Component, design §8). While the
// island loads, the static map stays visible under a loading badge; if the island fails, it stays for good.

const ListingMap = dynamic(() => import("./listing-map"), { ssr: false });

export interface MapToggleProps {
  /** Approximate position shared with the static map (approximatePosition(city, seed)). */
  center: { lng: number; lat: number };
  /** « Position approximative : {city}, {region} », the accessible name of the interactive map. */
  description: string;
  /** The static map. */
  children: ReactNode;
  className?: string;
}

type Mode = "static" | "interactive" | "unavailable";

const subscribeNever = () => () => {};

export function MapToggle({ center, description, children, className }: MapToggleProps) {
  const t = useTranslations("Map");
  const config = usePublicConfig();
  const webgl2 = useSyncExternalStore(subscribeNever, supportsWebGL2, () => false);
  const [mode, setMode] = useState<Mode>("static");
  const [ready, setReady] = useState(false);
  const map = config?.map ?? null;
  const interactive = mode === "interactive" && map !== null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="relative">
        <div aria-hidden={interactive && ready ? true : undefined}>{children}</div>
        {interactive ? (
          <div className={cn("absolute inset-0 overflow-hidden rounded-lg border border-border bg-surface-muted", ready ? "" : "invisible")}>
            <ListingMap
              center={center}
              pmtilesUrl={map.pmtilesUrl}
              attribution={map.attribution}
              description={description}
              labels={{
                zoomIn: t("zoomIn"),
                zoomOut: t("zoomOut"),
                scrollHint: t("scrollHint"),
                scrollHintMac: t("scrollHintMac"),
                touchHint: t("touchHint"),
              }}
              onReady={() => setReady(true)}
              onUnavailable={() => setMode("unavailable")}
            />
          </div>
        ) : null}
        {interactive && !ready ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
            <span className="flex items-center gap-2 rounded-full bg-surface/95 px-4 py-2 text-sm font-medium text-foreground shadow-lg shadow-bab-950/10">
              <KhatamLoader size="inline" />
              {t("loading")}
            </span>
          </div>
        ) : null}
      </div>
      {map && webgl2 && mode === "static" ? (
        <Button type="button" variant="outline" size="sm" className="self-start max-sm:h-11" data-testid="map-toggle" onClick={() => setMode("interactive")}>
          <MapIcon aria-hidden="true" />
          {t("showInteractive")}
        </Button>
      ) : null}
      {mode === "unavailable" ? (
        <p className="text-sm text-foreground-muted" role="status">
          {t("unavailable")}
        </p>
      ) : null}
    </div>
  );
}
