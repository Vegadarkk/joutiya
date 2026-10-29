"use client";

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronLeft, List, Map as MapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { bindHeaderSearch } from "@/components/layout/header-search-store";
import { searchPath, type SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { locationOf } from "../location";
import { carriedInputs, submittedParams } from "../search-bar";
import { useSearchNavigation } from "../search-navigation";
import { useSearchMap } from "./search-map-root";
import { dragHeight, settleSnap, sheetHeights, stepSnap, type SheetSnap } from "./sheet";

// Small islands of the map-first search (Carte vivante, lot 2): the Carte/Liste switch, the fold
// handle of the desktop list panel, the phone sheet's handle, the rows' hover and click wiring, and
// the binding of the header's search pill.

/** Carte / Liste: two pressed-state buttons. Absent where the map cannot be drawn. */
export function ViewToggle({ className }: { className?: string }) {
  const t = useTranslations("SearchMap.view");
  const state = useSearchMap();
  if (!state?.canMap) return null;
  const { view, setView } = state;
  const item = (value: "map" | "list", label: string, Icon: typeof MapIcon) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => setView(value)}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-[background-color,color] duration-150 ease-door",
        view === value ? "bg-surface-brand text-structure dark:bg-bab-700 dark:text-cream-100" : "text-foreground-muted hover:text-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t("label")} data-testid="view-toggle" className={cn("float-card inline-flex h-11 shrink-0 items-center gap-0.5 rounded-full p-1", className)}>
      {item("map", t("map"), MapIcon)}
      {item("list", t("list"), List)}
    </div>
  );
}

/** The tab on the edge of the desktop list panel: folds it away and brings it back. */
export function PanelHandle() {
  const t = useTranslations("SearchMap.panel");
  const state = useSearchMap();
  if (!state || state.view !== "map" || !state.canMap) return null;
  const { collapsed, setCollapsed } = state;
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-controls="search-panel"
      onClick={() => setCollapsed(!collapsed)}
      data-testid="panel-handle"
      className="search-panel-handle float-card max-lg:hidden"
    >
      <ChevronLeft className={cn("size-4 transition-transform duration-300 ease-door rtl:-scale-x-100", collapsed && "rotate-180")} aria-hidden="true" />
      <span className="sr-only">{collapsed ? t("expand") : t("collapse")}</span>
    </button>
  );
}

/** Top of a full sheet: under the header and the floating filters row (globals.css, 7.25rem). */
const SHEET_TOP_PX = 116;

/**
 * Handle of the phone sheet: drag it (pointer) or press it (keyboard, screen readers: one press
 * steps up, from full back down to peek); the arrow keys step too.
 */
export function SheetHandle() {
  const t = useTranslations("SearchMap.sheet");
  const state = useSearchMap();
  const drag = useRef<{ startY: number; startHeight: number; lastY: number; lastT: number; velocity: number; moved: boolean } | null>(null);
  if (!state || state.view !== "map" || !state.canMap) return null;
  const { snap, setSnap } = state;
  const panel = () => document.getElementById("search-panel");

  const next: SheetSnap = snap === "full" ? "peek" : stepSnap(snap, 1);
  const label = { peek: t("toPeek"), half: t("toHalf"), full: t("toFull") }[next];

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    const element = panel();
    if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const height = element.getBoundingClientRect().height;
    drag.current = { startY: event.clientY, startHeight: height, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, moved: false };
    element.dataset.dragging = "";
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    const element = panel();
    if (!current || !element) return;
    const delta = current.startY - event.clientY;
    if (Math.abs(delta) > 4) current.moved = true;
    const dt = Math.max(1, event.timeStamp - current.lastT);
    current.velocity = (current.lastY - event.clientY) / dt;
    current.lastY = event.clientY;
    current.lastT = event.timeStamp;
    const heights = sheetHeights(window.innerHeight, SHEET_TOP_PX);
    element.style.height = `${dragHeight(current.startHeight, delta, heights)}px`;
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    const element = panel();
    drag.current = null;
    if (!current || !element) return;
    delete element.dataset.dragging;
    if (!current.moved) {
      element.style.height = "";
      return;
    }
    const heights = sheetHeights(window.innerHeight, SHEET_TOP_PX);
    const settled = settleSnap(element.getBoundingClientRect().height, current.velocity, heights);
    element.style.height = "";
    setSnap(settled);
    // The click that follows a drag must not step the sheet again.
    event.currentTarget.dataset.dragged = "";
  }

  function onClick(event: MouseEvent<HTMLButtonElement>) {
    if (event.currentTarget.dataset.dragged !== undefined) {
      delete event.currentTarget.dataset.dragged;
      return;
    }
    setSnap(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") setSnap(stepSnap(snap, 1));
    else if (event.key === "ArrowDown") setSnap(stepSnap(snap, -1));
    else return;
    event.preventDefault();
  }

  return (
    <button
      type="button"
      aria-controls="search-panel"
      aria-label={label}
      data-testid="sheet-handle"
      data-snap={snap}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="search-sheet-handle lg:hidden"
    >
      <span aria-hidden="true" className="h-1.5 w-10 rounded-full bg-border-strong" />
    </button>
  );
}

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The server-rendered rows: hovering or focusing one lights its pin; on a desktop map a plain click
 * on its link opens the detail panel instead of the listing page (the link stays a real link).
 */
export function RowsArea({ children, className }: { children: ReactNode; className?: string }) {
  const state = useSearchMap();
  const area = useRef<HTMLDivElement>(null);
  const ids = state?.listings.map((listing) => listing.id).join(",");

  // A new page of results starts at the top of the list.
  useEffect(() => {
    // Desktop: the rows scroll; phones: the whole sheet does.
    area.current?.scrollTo?.({ top: 0 });
    area.current?.closest(".search-panel")?.scrollTo?.({ top: 0 });
  }, [ids]);

  const rowOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-map-row]") : null);
  const mapOn = state !== null && state.view === "map" && state.canMap;

  return (
    <div
      ref={area}
      data-map-rows=""
      className={className}
      onPointerOver={(event) => {
        if (!mapOn || event.pointerType === "touch") return;
        state.highlight(rowOf(event.target)?.dataset.listingId ?? null);
      }}
      onPointerLeave={() => mapOn && state.highlight(null)}
      onFocus={(event) => mapOn && state.highlight(rowOf(event.target)?.dataset.listingId ?? null)}
      // Capture phase: next/link navigates in its own click handler unless the event arrives
      // already prevented.
      onClickCapture={(event) => {
        if (!mapOn || !state.desktop || !plainClick(event)) return;
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-row-link]") : null;
        const id = link ? rowOf(link)?.dataset.listingId : undefined;
        if (!link || !id) return;
        event.preventDefault();
        state.select(id, link);
      }}
    >
      {children}
    </div>
  );
}

/** Binds the header's search pill to this search (header-search-store.ts). */
export function HeaderSearchBridge({ params }: { params: SearchParams }) {
  const navigation = useSearchNavigation();
  const key = searchPath(params);
  useLayoutEffect(() => {
    return bindHeaderSearch({
      key,
      q: params.q ?? "",
      place: locationOf(params),
      carried: carriedInputs(params),
      submit: (q, place) => navigation?.navigate(submittedParams(params, q, place)),
    });
    // `key` is the whole search: the params object is recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, navigation]);
  return null;
}
