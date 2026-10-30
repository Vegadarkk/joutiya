"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PublicMapConfig } from "@/lib/config/public-types";
import { supportsWebGL2 } from "@/lib/map/webgl";
import { canonicalSearchParams, type SearchParams, type SearchZone } from "@/lib/search/params";
import { useExamplesHidden } from "@/components/examples/use-examples";
import { useSearchNavigation } from "../search-navigation";
import { JOB_SEEKER_SUBCATEGORY, type MapListing } from "./map-listings";
import { SHEET_SNAPS, type SheetSnap } from "./sheet";
import { browserViewContext, initialView, mapPossible, rememberView, type SearchView } from "./view-mode";

// Client root of the map-first search (Carte vivante, lot 2) and of the home page's living map (lot
// 3). The server renders the whole panel (rows, grid, filters) inside it; this island only holds the
// view state: map or list, the result under the pointer, the one open in the detail panel (desktop),
// the list panel folded or not, the height of the phone sheet. The CSS reads it from data attributes
// (globals.css, `search-map`).

export const DESKTOP_QUERY = "(min-width: 64rem)";

interface SearchMapState {
  variant: SearchMapVariant;
  view: SearchView;
  setView: (view: SearchView) => void;
  /** Hydrated: the client decided the view. */
  enhanced: boolean;
  /** The map can be drawn here (configured, WebGL2, not failed). */
  canMap: boolean;
  /** The map failed to load: the list takes over for this page. */
  failed: boolean;
  fail: () => void;
  map: PublicMapConfig | null;
  desktop: boolean;
  listings: readonly MapListing[];
  /** Job seekers' ads on this page, and whether the map shows them (hidden unless searched for). */
  jobSeekers: { count: number; shown: boolean; setShown: (shown: boolean) => void };
  params: SearchParams;
  highlighted: string | null;
  highlight: (id: string | null) => void;
  selected: string | null;
  select: (id: string | null, opener?: HTMLElement | null) => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  snap: SheetSnap;
  setSnap: (snap: SheetSnap) => void;
  /** "Rechercher dans cette zone". */
  searchZone: (zone: SearchZone) => void;
}

const SearchMapContext = createContext<SearchMapState | null>(null);

export function useSearchMap(): SearchMapState | null {
  return useContext(SearchMapContext);
}

const subscribeNever = () => () => {};

// Read once per page load (a stable snapshot): storage, connection and WebGL2 do not change under us.
const startViews = new Map<boolean, SearchView>();
function startView(hasMap: boolean): SearchView {
  let view = startViews.get(hasMap);
  if (!view) {
    view = initialView(browserViewContext(hasMap, supportsWebGL2()));
    startViews.set(hasMap, view);
  }
  return view;
}

function useDesktop(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(DESKTOP_QUERY);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/** Rows of the list: the one under the pointer and the one open, as attributes the CSS reads. */
function useRowMarks(highlighted: string | null, selected: string | null) {
  useEffect(() => {
    const rows = document.querySelectorAll<HTMLElement>("[data-map-row]");
    for (const row of rows) {
      const id = row.dataset.listingId;
      row.toggleAttribute("data-highlight", id !== undefined && id === highlighted);
      row.toggleAttribute("data-selected", id !== undefined && id === selected);
    }
  }, [highlighted, selected]);
}

/** Which page the map serves: the search results, or the home page's recent listings (lot 3). */
export type SearchMapVariant = "search" | "home";

export interface SearchMapRootProps {
  /** Server's guess: "map" when a basemap is configured (the client checks WebGL2 and the link). */
  serverView: SearchView;
  variant?: SearchMapVariant;
  /** Height of the phone sheet on arrival (the home page opens it half way). */
  startSnap?: SheetSnap;
  map: PublicMapConfig | null;
  listings: readonly MapListing[];
  params: SearchParams;
  className?: string;
  children: ReactNode;
}

export function SearchMapRoot({ serverView, variant = "search", startSnap = "peek", map, listings: given, params, className, children }: SearchMapRootProps) {
  const navigation = useSearchNavigation();
  // « Masquer les annonces exemples »: the home page is rendered once for everyone, its pins are not.
  const examplesHidden = useExamplesHidden();
  // Job seekers' ads stay off the map unless the visitor searches for them or turns the filter off:
  // they would crowd a search for anything else (owner, 2026-10-30).
  const [jobSeekersShown, setJobSeekersShown] = useState(params.subcategory === JOB_SEEKER_SUBCATEGORY);
  const jobSeekerCount = useMemo(() => given.filter((listing) => listing.jobSeeker && !(examplesHidden && listing.example)).length, [examplesHidden, given]);
  const listings = useMemo(
    () => given.filter((listing) => !(examplesHidden && listing.example) && (jobSeekersShown || !listing.jobSeeker)),
    [examplesHidden, given, jobSeekersShown],
  );
  const webgl2 = useSyncExternalStore(subscribeNever, supportsWebGL2, () => false);
  const desktop = useDesktop();
  const [failed, setFailed] = useState(false);
  const canMap = mapPossible({ hasMap: map !== null, webgl2 }) && !failed;
  // The view this browser starts in (hydrated: null on the server and during hydration).
  const autoView = useSyncExternalStore(subscribeNever, () => startView(map !== null), () => null);
  const enhanced = autoView !== null;
  const [chosen, setChosen] = useState<SearchView | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [snap, setSnap] = useState<SheetSnap>(startSnap);

  const wanted = chosen ?? autoView ?? serverView;
  const view: SearchView = enhanced && !canMap ? "list" : wanted;

  const setView = useCallback((next: SearchView) => {
    rememberView(next);
    setChosen(next);
    setSelected(null);
  }, []);

  // A new page of results: nothing stays highlighted or open.
  const ids = listings.map((listing) => listing.id).join(",");
  const [shownIds, setShownIds] = useState(ids);
  if (shownIds !== ids) {
    setShownIds(ids);
    setHighlighted(null);
    setSelected(null);
  }

  const select = useCallback((id: string | null, opener?: HTMLElement | null) => {
    setSelected((current) => {
      if (id === null) {
        // Focus goes back to what opened the panel (the row's link or the pin).
        const back = current?.opener;
        if (back?.isConnected) window.requestAnimationFrame(() => back.focus({ preventScroll: true }));
        return null;
      }
      return { id, opener: opener ?? null };
    });
  }, []);

  const searchZone = useCallback(
    (zone: SearchZone) => {
      // From the home page this opens the search page on that zone (its params are empty).
      // An area of the map, not the visitor's position: « À N km de vous » no longer applies.
      const next = canonicalSearchParams({ ...params, zone, fromPosition: undefined, page: undefined });
      navigation?.navigate(next, { scroll: variant === "home" });
    },
    [navigation, params, variant],
  );

  useRowMarks(highlighted, selected?.id ?? null);

  // The phone sheet's height lives on the root element: the floating "Vendre" arch stands above it.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.searchSnap = snap;
    return () => {
      delete root.dataset.searchSnap;
    };
  }, [snap]);

  const value = useMemo<SearchMapState>(
    () => ({
      variant,
      view,
      setView,
      enhanced,
      canMap,
      failed,
      fail: () => setFailed(true),
      map,
      desktop,
      listings,
      jobSeekers: { count: jobSeekerCount, shown: jobSeekersShown, setShown: setJobSeekersShown },
      params,
      highlighted,
      highlight: setHighlighted,
      selected: selected?.id ?? null,
      select,
      collapsed,
      setCollapsed,
      snap,
      setSnap: (next: SheetSnap) => setSnap(SHEET_SNAPS.includes(next) ? next : "peek"),
      searchZone,
    }),
    [variant, view, setView, enhanced, canMap, failed, map, desktop, listings, jobSeekerCount, jobSeekersShown, params, highlighted, selected, select, collapsed, snap, searchZone],
  );

  return (
    <SearchMapContext.Provider value={value}>
      <div
        data-search-root=""
        data-search-variant={variant}
        data-search-start={startSnap}
        data-search-view={view}
        data-search-enhanced={enhanced ? "" : undefined}
        data-search-panel={collapsed ? "collapsed" : "open"}
        data-search-detail={selected && desktop && view === "map" ? "open" : undefined}
        className={className}
      >
        {children}
      </div>
    </SearchMapContext.Provider>
  );
}

/** Children shown in the list view only (the card grid and its ad slots). */
export function ListViewOnly({ serverView, children }: { serverView: SearchView; children: ReactNode }) {
  const state = useSearchMap();
  const view = state?.view ?? serverView;
  return view === "list" ? children : null;
}
