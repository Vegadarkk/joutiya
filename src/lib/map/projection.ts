// Web-Mercator projection (EPSG:3857) for the static SVG map and the interactive map's metrics.
// Pure functions, client-safe, no dependency.

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A projected point in SVG user units: [x, y], y growing downwards. */
export type Point = [number, number];

/** Web Mercator is undefined at the poles: MapLibre's limit. */
export const MERCATOR_MAX_LATITUDE = 85.05112878;

/** Earth circumference at the equator (WGS 84), metres. */
const EARTH_CIRCUMFERENCE = 40_075_016.686;

/** MapLibre renders 512 px tiles: the world is 512 px wide at zoom 0. */
const TILE_SIZE = 512;

const clampLatitude = (lat: number) => Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat));

/** Mercator x of a longitude on the unit world square, 0 at 180° W. */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Mercator y of a latitude on the unit world square, 0 at the north pole. */
export function mercatorY(lat: number): number {
  const phi = (clampLatitude(lat) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}

/** Ground resolution of one screen pixel at a latitude and a MapLibre zoom level, metres. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom);
}

export interface Projection {
  readonly bbox: Bbox;
  /** SVG user units of the viewBox. */
  readonly width: number;
  readonly height: number;
  /** `0 0 width height`. */
  readonly viewBox: string;
  /** Projects a coordinate into user units (unrounded). */
  project(lng: number, lat: number): Point;
  /** Whether a projected point lies inside the viewBox. */
  contains(point: Point): boolean;
}

/** Rounds to `decimals` and drops the trailing zeros ("12.0" -> "12"). */
export function formatNumber(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // Avoid "-0".
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * A projection that maps a bounding box onto a viewBox `width` units wide; the height follows the
 * Mercator aspect ratio of the box (rounded to one decimal so the viewBox string is stable).
 */
export function createProjection(bbox: Bbox, width = 600): Projection {
  if (!(bbox.east > bbox.west) || !(bbox.north > bbox.south)) throw new RangeError("invalid bbox");
  const x0 = mercatorX(bbox.west);
  const x1 = mercatorX(bbox.east);
  const y0 = mercatorY(bbox.north);
  const y1 = mercatorY(bbox.south);
  const scale = width / (x1 - x0);
  const height = Number(formatNumber((y1 - y0) * scale, 1));
  return {
    bbox,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    project(lng, lat) {
      return [(mercatorX(lng) - x0) * scale, (mercatorY(lat) - y0) * scale];
    },
    contains([x, y]) {
      return x >= 0 && x <= width && y >= 0 && y <= height;
    },
  };
}

/**
 * SVG path data of a closed ring in user units: `M x y x y ... Z` (coordinate pairs after `M` are
 * implicit line-to commands). Consecutive duplicates after rounding are dropped.
 */
export function ringToPath(ring: readonly Point[], decimals = 1): string {
  const parts: string[] = [];
  let last = "";
  // The closing point repeats the first one: `Z` closes the ring.
  const open = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.slice(0, -1) : ring;
  for (const [x, y] of open) {
    const pair = `${formatNumber(x, decimals)} ${formatNumber(y, decimals)}`;
    if (pair === last) continue;
    parts.push(pair);
    last = pair;
  }
  return parts.length >= 3 ? `M${parts.join(" ")}Z` : "";
}
