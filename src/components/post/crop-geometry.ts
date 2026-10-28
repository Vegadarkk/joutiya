// Crop rectangle of the photo crop dialog, in fractions of the image ([0, 1] on both axes). Pure:
// the dialog maps pointer and keyboard moves to these functions, the canvas maps the result to pixels.

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CropCorner = "nw" | "ne" | "sw" | "se";

/** Smallest side kept, as a fraction of the image side (a sliver would not show the object). */
export const MIN_CROP = 0.2;
/** Starting proposal: the centre, a tenth trimmed on every side. */
export const INITIAL_CROP: CropRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The rectangle kept inside the image and at least MIN_CROP on each side. */
export function clampRect(rect: CropRect): CropRect {
  const w = clamp(rect.w, MIN_CROP, 1);
  const h = clamp(rect.h, MIN_CROP, 1);
  return { x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h), w, h };
}

/** Moves the whole rectangle; it stops at the image edges. */
export function moveRect(rect: CropRect, dx: number, dy: number): CropRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Drags one corner; the opposite corner stays put. */
export function resizeRect(rect: CropRect, corner: CropCorner, dx: number, dy: number): CropRect {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const x0 = west ? clamp(left + dx, 0, right - MIN_CROP) : left;
  const x1 = west ? right : clamp(right + dx, left + MIN_CROP, 1);
  const y0 = north ? clamp(top + dy, 0, bottom - MIN_CROP) : top;
  const y1 = north ? bottom : clamp(bottom + dy, top + MIN_CROP, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Pixel area of the rectangle on an image of the given size (whole pixels, inside the image). */
export function cropPixels(rect: CropRect, width: number, height: number): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.round(clamp(rect.x, 0, 1) * width);
  const sy = Math.round(clamp(rect.y, 0, 1) * height);
  const sw = Math.max(1, Math.min(width - sx, Math.round(rect.w * width)));
  const sh = Math.max(1, Math.min(height - sy, Math.round(rect.h * height)));
  return { sx, sy, sw, sh };
}
