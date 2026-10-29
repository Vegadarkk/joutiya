// Bottom sheet of the phone map (Carte vivante, lot 2): three heights, peek (the count and the start
// of the first result), half (the map and the list share the screen) and full (the list under the
// header). Pure rules, read by the sheet island and the unit tests.

export const SHEET_SNAPS = ["peek", "half", "full"] as const;
export type SheetSnap = (typeof SHEET_SNAPS)[number];

/** Peek height, px: the handle, the heading and the count, and the top of the first row. */
export const SHEET_PEEK_PX = 168;
/** A flick faster than this (px per ms) goes on to the next height in its direction. */
export const SHEET_FLICK_SPEED = 0.45;

export type SheetHeights = Record<SheetSnap, number>;

/** Heights for a viewport of `viewport` px whose header ends at `top` px; always increasing. */
export function sheetHeights(viewport: number, top: number): SheetHeights {
  const full = Math.max(SHEET_PEEK_PX + 2, Math.round(viewport - top));
  const peek = Math.min(SHEET_PEEK_PX, full - 2);
  const half = Math.min(full - 1, Math.max(peek + 1, Math.round(viewport * 0.5)));
  return { peek, half, full };
}

/** The next height up (1) or down (-1), staying at the ends. */
export function stepSnap(snap: SheetSnap, direction: 1 | -1): SheetSnap {
  const index = SHEET_SNAPS.indexOf(snap) + direction;
  return SHEET_SNAPS[Math.min(SHEET_SNAPS.length - 1, Math.max(0, index))] ?? snap;
}

/**
 * Where a drag released at `height` px settles. `velocity` is px per ms, positive while the sheet
 * grows: a flick goes to the next height in its direction, a slow release to the nearest one.
 */
export function settleSnap(height: number, velocity: number, heights: SheetHeights): SheetSnap {
  if (Math.abs(velocity) >= SHEET_FLICK_SPEED) {
    if (velocity > 0) return SHEET_SNAPS.find((snap) => heights[snap] > height + 1) ?? "full";
    return [...SHEET_SNAPS].reverse().find((snap) => heights[snap] < height - 1) ?? "peek";
  }
  let best: SheetSnap = "peek";
  for (const snap of SHEET_SNAPS) if (Math.abs(heights[snap] - height) < Math.abs(heights[best] - height)) best = snap;
  return best;
}

/** Height while dragging: inside the range, with a little give past either end. */
export function dragHeight(start: number, delta: number, heights: SheetHeights): number {
  const raw = start + delta;
  if (raw < heights.peek) return heights.peek - (heights.peek - raw) / 4;
  if (raw > heights.full) return heights.full + (raw - heights.full) / 4;
  return raw;
}
