// Minimal GeoJSON types for the regions file (RFC 7946). Client-safe, no dependency.

export type Position = [number, number];
export type LinearRing = Position[];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: LinearRing[];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: LinearRing[][];
}

export type RegionGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface RegionFeature {
  type: "Feature";
  properties: { code: string; slug: string };
  geometry: RegionGeometry;
}

/** The 12 regions, with the licence of the source as foreign members (RFC 7946 §6.1). */
export interface RegionsFeatureCollection {
  type: "FeatureCollection";
  attribution: string;
  license: string;
  source: string;
  features: RegionFeature[];
}

/** Every ring of a geometry, outer rings and holes alike, in document order. */
export function ringsOf(geometry: RegionGeometry): LinearRing[] {
  return geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
}

/** Polygons of a geometry: one array of rings per polygon. */
export function polygonsOf(geometry: RegionGeometry): LinearRing[][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}
