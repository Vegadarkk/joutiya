import { describe, expect, it } from "vitest";
import { INITIAL_CROP, MIN_CROP, clampRect, cropPixels, moveRect, resizeRect } from "@/components/post/crop-geometry";

// Crop rectangle of the photo crop dialog (faces found on a photo): fractions of the image, kept
// inside it and at least MIN_CROP on each side, mapped to whole pixels for the canvas.

const close = (actual: Record<string, number>, expected: Record<string, number>) => {
  for (const [key, value] of Object.entries(expected)) expect(actual[key], key).toBeCloseTo(value, 6);
};

describe("crop geometry", () => {
  it("moves the frame and stops it at the image edges", () => {
    close({ ...moveRect(INITIAL_CROP, 0.05, -0.05) }, { x: 0.15, y: 0.05, w: 0.8, h: 0.8 });
    close({ ...moveRect(INITIAL_CROP, 0.5, 0.5) }, { x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
    close({ ...moveRect(INITIAL_CROP, -1, -1) }, { x: 0, y: 0 });
  });

  it("resizes from a corner, the opposite corner fixed, never below the minimum", () => {
    close({ ...resizeRect(INITIAL_CROP, "se", -0.3, -0.2) }, { x: 0.1, y: 0.1, w: 0.5, h: 0.6 });
    close({ ...resizeRect(INITIAL_CROP, "nw", 0.2, 0.1) }, { x: 0.3, y: 0.2, w: 0.6, h: 0.7 });
    const tiny = resizeRect(INITIAL_CROP, "ne", -5, 5);
    close({ ...tiny }, { x: 0.1, w: MIN_CROP, h: MIN_CROP, y: 0.9 - MIN_CROP });
    close({ ...resizeRect(INITIAL_CROP, "sw", -5, 5) }, { x: 0, y: 0.1, w: 0.9, h: 0.9 });
  });

  it("clamps an out-of-range rectangle into the image", () => {
    close({ ...clampRect({ x: -0.2, y: 0.95, w: 2, h: 0.05 }) }, { x: 0, y: 1 - MIN_CROP, w: 1, h: MIN_CROP });
  });

  it("maps the rectangle to whole pixels inside the image", () => {
    expect(cropPixels(INITIAL_CROP, 1600, 1200)).toEqual({ sx: 160, sy: 120, sw: 1280, sh: 960 });
    expect(cropPixels({ x: 0.999, y: 0, w: 0.2, h: 1 }, 1000, 500)).toEqual({ sx: 999, sy: 0, sw: 1, sh: 500 });
  });
});
