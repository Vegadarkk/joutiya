import { describe, expect, it } from "vitest";
import { MOROCCO_BBOX } from "@/config/regions";
import { createProjection, formatNumber, mercatorX, mercatorY, metersPerPixel, ringToPath, type Point } from "@/lib/map/projection";
import { regionsSvg, SVG_WIDTH } from "@/lib/map/regions-paths";
import { douglasPeuckerMask, simplifyRingsShared } from "@/lib/map/simplify";

describe("Web-Mercator projection", () => {
  it("maps the world square to [0, 1]", () => {
    expect(mercatorX(-180)).toBe(0);
    expect(mercatorX(0)).toBe(0.5);
    expect(mercatorX(180)).toBe(1);
    expect(mercatorY(0)).toBeCloseTo(0.5, 12);
    expect(mercatorY(85.05112878)).toBeCloseTo(0, 6);
    expect(mercatorY(-85.05112878)).toBeCloseTo(1, 6);
    // Clamped at the poles (no infinity).
    expect(mercatorY(90)).toBeCloseTo(0, 6);
    expect(mercatorY(-90)).toBeCloseTo(1, 6);
  });

  it("projects the bbox corners onto the viewBox corners", () => {
    const p = createProjection(MOROCCO_BBOX, SVG_WIDTH);
    expect(p.width).toBe(600);
    expect(p.viewBox).toBe(`0 0 600 ${p.height}`);
    // Morocco is a little taller than wide in Mercator (16.4 deg of longitude for 15.4 deg of latitude).
    expect(p.height).toBeGreaterThan(600);
    expect(p.height).toBeLessThan(700);
    const [x0, y0] = p.project(MOROCCO_BBOX.west, MOROCCO_BBOX.north);
    const [x1, y1] = p.project(MOROCCO_BBOX.east, MOROCCO_BBOX.south);
    expect(x0).toBeCloseTo(0, 9);
    expect(y0).toBeCloseTo(0, 9);
    expect(x1).toBeCloseTo(600, 9);
    expect(y1).toBeCloseTo(p.height, 0);
    expect(p.contains([300, 300])).toBe(true);
    expect(p.contains([-1, 300])).toBe(false);
    expect(p.contains([300, p.height + 1])).toBe(false);
  });

  it("keeps east to the right and north to the top", () => {
    const p = createProjection(MOROCCO_BBOX, 600);
    const [xCasa, yCasa] = p.project(-7.59, 33.57);
    const [xOujda, yOujda] = p.project(-1.91, 34.68);
    expect(xOujda).toBeGreaterThan(xCasa);
    expect(yOujda).toBeLessThan(yCasa);
  });

  it("rejects an empty bbox", () => {
    expect(() => createProjection({ west: 0, south: 0, east: 0, north: 1 })).toThrow(RangeError);
  });

  it("computes the ground resolution of a MapLibre pixel (512 px tiles)", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.517, 2);
    // 600 m at zoom 12 near Casablanca is about 38 px: a visible area, not a point.
    const radius = 600 / metersPerPixel(33.57, 12);
    expect(radius).toBeGreaterThan(30);
    expect(radius).toBeLessThan(45);
  });

  it("formats numbers without trailing zeros or negative zero", () => {
    expect(formatNumber(12.04, 1)).toBe("12");
    expect(formatNumber(12.06, 1)).toBe("12.1");
    expect(formatNumber(-0.01, 1)).toBe("0");
  });

  it("builds compact closed path data and drops duplicate points", () => {
    const ring: Point[] = [
      [0, 0],
      [10.04, 0],
      [10.04, 0.01],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    expect(ringToPath(ring, 1)).toBe("M0 0 10 0 10 10 0 10Z");
    expect(ringToPath([[0, 0], [1, 1]], 1)).toBe("");
  });
});

describe("Douglas-Peucker", () => {
  it("keeps the ends and the vertices farther than the tolerance", () => {
    const line: Point[] = [
      [0, 0],
      [1, 0.01],
      [2, 0],
      [3, 2],
      [4, 0],
    ];
    expect(douglasPeuckerMask(line, 0.1)).toEqual([true, false, true, true, true]);
    expect(douglasPeuckerMask(line, 5)).toEqual([true, false, false, false, true]);
  });

  it("simplifies shared borders identically on both sides", () => {
    // Two squares sharing the edge x = 1, with a tiny bump on the shared edge.
    const shared: Point[] = [
      [1, 0],
      [1, 0.5],
      [1.01, 0.6],
      [1, 1],
    ];
    const left: Point[] = [[0, 0], ...shared, [0, 1], [0, 0]];
    const right: Point[] = [[2, 0], [2, 1], ...[...shared].reverse(), [2, 0]];
    const [l, r] = simplifyRingsShared([left, right], 0.1);
    expect(l!.length).toBeGreaterThanOrEqual(5);
    const edge = (ring: Point[]) => ring.filter(([x]) => x >= 1 && x < 2).map(String).sort();
    expect(edge(l!)).toEqual(edge(r!));
    expect(l![0]).toEqual(l![l!.length - 1]);
  });

  it("drops a ring that collapses", () => {
    const tiny: Point[] = [
      [0, 0],
      [0.001, 0],
      [0, 0.001],
      [0, 0],
    ];
    const [out] = simplifyRingsShared([tiny], 1);
    // A ring keeps at least its start and the farthest vertex; with 3 kept it survives, else it is empty.
    expect(out!.length === 0 || out!.length >= 4).toBe(true);
  });
});

describe("regionsSvg", () => {
  it("projects the 12 regions into non-empty paths inside the viewBox, once", () => {
    const first = regionsSvg();
    expect(regionsSvg()).toBe(first);
    expect(first.paths).toHaveLength(12);
    const totalVertices = first.paths.reduce((n, p) => n + (p.d.match(/ /g)?.length ?? 0), 0);
    // Small enough for inline SVG, detailed enough for a 1 px outline at 400 px wide.
    expect(totalVertices).toBeGreaterThan(600);
    expect(totalVertices).toBeLessThan(2600);
    for (const path of first.paths) {
      expect(path.d).toMatch(/^M[\d. ]+Z/);
      const numbers = path.d.replace(/[MZ]/g, " ").trim().split(/\s+/).map(Number);
      for (let i = 0; i < numbers.length; i += 2) {
        expect(first.projection.contains([numbers[i]!, numbers[i + 1]!])).toBe(true);
      }
    }
  });
});
