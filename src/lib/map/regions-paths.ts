// SVG paths of the 12 regions for the static map (D10): projected once per process from the regions
// GeoJSON through the Web-Mercator projection of MOROCCO_BBOX, simplified in SVG units so the inline
// markup stays small (~1 300 vertices) while shared borders stay identical on both sides.

import { MOROCCO_BBOX } from "@/config/regions";
import { ringsOf } from "./geojson-types";
import { createProjection, ringToPath, type Point, type Projection } from "./projection";
import { REGIONS_GEOJSON } from "./regions-geojson";
import { simplifyRingsShared } from "./simplify";

/** ViewBox width in user units; the height follows the Mercator aspect of MOROCCO_BBOX (~645). */
export const SVG_WIDTH = 600;
/** Simplification tolerance in user units: 0.5 unit ~ 1.4 km, under a third of a pixel at 400 px wide. */
const SVG_TOLERANCE = 0.5;
/** Decimals of the path coordinates (0.1 unit ~ 280 m). */
export const SVG_DECIMALS = 1;

export interface RegionPath {
  code: string;
  slug: string;
  /** Path data of every ring of the region (`M ... Z` per ring). */
  d: string;
}

export interface RegionsSvg {
  projection: Projection;
  paths: readonly RegionPath[];
}

let cached: RegionsSvg | undefined;

/** The projected regions, computed once and shared by every render. */
export function regionsSvg(): RegionsSvg {
  if (cached) return cached;
  const projection = createProjection(MOROCCO_BBOX, SVG_WIDTH);
  const features = REGIONS_GEOJSON.features;
  const owners: number[] = [];
  const rings: Point[][] = [];
  features.forEach((feature, index) => {
    for (const ring of ringsOf(feature.geometry)) {
      rings.push(ring.map(([lng, lat]) => projection.project(lng, lat)));
      owners.push(index);
    }
  });
  const parts: string[][] = features.map(() => []);
  simplifyRingsShared(rings, SVG_TOLERANCE).forEach((ring, i) => {
    const d = ringToPath(ring, SVG_DECIMALS);
    if (d) parts[owners[i]!]!.push(d);
  });
  cached = {
    projection,
    paths: features.map((feature, i) => ({ code: feature.properties.code, slug: feature.properties.slug, d: parts[i]!.join("") })),
  };
  return cached;
}
