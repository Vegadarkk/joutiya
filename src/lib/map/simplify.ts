// Douglas-Peucker simplification for the static map (the GeoJSON itself is simplified by
// scripts/geo/build-regions-geojson.mjs with the same algorithm; this pass works in SVG units).

import type { Point } from "./projection";

/** Keep mask of an open polyline: both ends and every vertex farther than `tolerance` from the chord. */
export function douglasPeuckerMask(points: readonly Point[], tolerance: number): boolean[] {
  const keep = new Array<boolean>(points.length).fill(false);
  if (points.length === 0) return keep;
  keep[0] = true;
  keep[points.length - 1] = true;
  const tolerance2 = tolerance * tolerance;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = points[a]!;
    const [bx, by] = points[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    let farthest = -1;
    let farthest2 = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]!;
      let d2: number;
      if (length2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > farthest2) {
        farthest2 = d2;
        farthest = i;
      }
    }
    if (farthest2 > tolerance2) {
      keep[farthest] = true;
      stack.push([a, farthest], [farthest, b]);
    }
  }
  return keep;
}

const keyOf = (p: Point) => `${p[0]},${p[1]}`;

/**
 * Simplifies closed rings together: a vertex kept by any ring is kept in every ring that holds the same
 * coordinate, so borders shared by two regions stay identical and never open a hairline gap. Rings that
 * collapse (fewer than 3 distinct vertices) come back empty. Output rings are closed.
 */
export function simplifyRingsShared(rings: readonly (readonly Point[])[], tolerance: number): Point[][] {
  const kept = new Set<string>();
  for (const ring of rings) {
    const open = openRing(ring);
    if (open.length < 3) continue;
    const mask = douglasPeuckerMask(open, tolerance);
    // Also keep the vertex farthest from the start so a ring never degenerates into a segment.
    let far = 0;
    let far2 = -1;
    for (let i = 1; i < open.length; i++) {
      const d2 = (open[i]![0] - open[0]![0]) ** 2 + (open[i]![1] - open[0]![1]) ** 2;
      if (d2 > far2) {
        far2 = d2;
        far = i;
      }
    }
    mask[far] = true;
    open.forEach((p, i) => {
      if (mask[i]) kept.add(keyOf(p));
    });
  }
  return rings.map((ring) => {
    const points = openRing(ring).filter((p) => kept.has(keyOf(p)));
    return points.length >= 3 ? [...points, points[0]!] : [];
  });
}

function openRing(ring: readonly Point[]): Point[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1];
  return (closed ? ring.slice(0, -1) : ring).map((p) => [p[0], p[1]]);
}
