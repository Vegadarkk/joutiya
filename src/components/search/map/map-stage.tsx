"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { KhatamLoader } from "@/components/ui/khatam-loader";
import { useSearchMap } from "./search-map-root";

// The map behind the list (Carte vivante, lot 2): mounted only in the map view, once hydrated (the
// list painted first), so the ~430 KB of MapLibre never loads for a list reader.

const SearchMap = dynamic(() => import("./search-map"), { ssr: false });

export function MapStage() {
  const t = useTranslations("SearchMap");
  const state = useSearchMap();
  const [ready, setReady] = useState(false);
  if (!state || !state.enhanced || state.view !== "map" || !state.canMap) return null;
  return (
    <div className="search-stage" data-testid="search-stage" data-ready={ready ? "" : undefined}>
      <SearchMap onReady={() => setReady(true)} />
      {ready ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <span className="flex items-center gap-2 rounded-full bg-surface/95 px-4 py-2 text-sm font-medium text-foreground shadow-lg shadow-bab-950/10">
            <KhatamLoader size="inline" />
            {t("loading")}
          </span>
        </div>
      )}
      <ul aria-label={t("legend.label")} className="search-legend float-card max-lg:hidden">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-3 w-4 rounded-full border border-border-strong bg-surface" />
          {t("legend.price")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-3.5 w-2.5 rounded-t-full rounded-b-[2px] bg-featured" />
          {t("legend.featured")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-today" />
          {t("legend.today")}
        </li>
        <li className="text-foreground-muted">{t("legend.approximate")}</li>
      </ul>
    </div>
  );
}

/** Said once when the map could not load: the list stays. */
export function MapFailedNotice() {
  const t = useTranslations("SearchMap");
  const state = useSearchMap();
  if (!state?.failed) return null;
  return (
    <p role="status" className="rounded-md bg-surface-muted px-3 py-2 text-sm text-foreground-muted">
      {t("unavailable")}
    </p>
  );
}
