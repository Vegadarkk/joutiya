import { SHEET_PEEK_PX, type SheetSnap } from "./sheet";

// Room the floating pieces take over the search map (Carte vivante, lot 2), as MapLibre padding:
// the map centres, fits and searches "this zone" inside what is left visible. Physical sides
// (MapLibre's), mirrored in Arabic where the list panel sits on the right.

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MapLayoutState {
  desktop: boolean;
  rtl: boolean;
  /** Desktop: the list panel folded away. */
  collapsed: boolean;
  /** Desktop: the detail panel open at the end side. */
  detail: boolean;
  /** Phones: the sheet's height and the viewport's. */
  snap: SheetSnap;
  viewportHeight: number;
}

/** Desktop list panel (25rem) and detail panel (24rem), with their 1rem margins. */
export const PANEL_PX = 400;
export const DETAIL_PX = 384;
const GAP = 16;
/** Header row and the filters row above the map. */
const DESKTOP_TOP = 140;
const PHONE_TOP = 124;

export function mapPadding(state: MapLayoutState): MapPadding {
  if (!state.desktop) {
    const sheet = state.snap === "peek" ? SHEET_PEEK_PX : Math.round(state.viewportHeight * 0.5);
    // Full sheet: the map hides behind it; keep the last visible framing (the half one).
    const bottom = Math.min(sheet, Math.max(0, state.viewportHeight - PHONE_TOP - 120));
    return { top: PHONE_TOP, right: GAP, bottom: bottom + GAP, left: GAP };
  }
  const start = state.collapsed ? GAP * 2 : PANEL_PX + GAP * 2;
  const end = state.detail ? DETAIL_PX + GAP * 2 : GAP * 4;
  return { top: DESKTOP_TOP, bottom: 72, left: state.rtl ? end : start, right: state.rtl ? start : end };
}
