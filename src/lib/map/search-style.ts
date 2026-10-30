import { namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";
import { buildHouseStyle } from "./style";

// Style of the search map (Carte vivante, lot 2): the house basemap tinted to the brand ground (bab
// green, cream sand, pale sea), no administrative line at all (contested borders: neither the
// tiles' boundaries nor our regions), and the results as one clustered GeoJSON source. The pins
// themselves are HTML markers drawn by the island; the style only adds a soft density halo.

export const PINS_SOURCE = "joutiya-pins";
export const HALO_LAYER = "joutiya-pins-halo";

/** The search map may zoom past the z12 extract (vector tiles overzoom cleanly). */
export const SEARCH_ZOOM = { min: 5, max: 13.5, clusterMax: 13, fit: 12, city: 10 } as const;
/** Pins closer than this (px) gather in one count bubble. */
export const CLUSTER_RADIUS_PX = 46;

export type MapTheme = "light" | "dark";

const LIGHT_TINT: Partial<Flavor> = {
  // Outside the Morocco archive only the background shows: sea-coloured, never a hard edge.
  background: "#cfe3e6",
  earth: "#eef3ef",
  water: "#cfe3e6",
  park_a: "#dcebdc",
  park_b: "#d5e7d5",
  wood_a: "#d9e8d6",
  wood_b: "#d2e4cf",
  scrub_a: "#e1ece0",
  scrub_b: "#dae8d9",
  sand: "#f2e9d8",
  beach: "#f2e9d8",
  buildings: "#e3e9e4",
  minor_a: "#ffffff",
  minor_b: "#ffffff",
  major: "#ffffff",
  highway: "#fbf7ef",
};

// Dark: the sea a shade darker than the land and the roads lighter than both, so the coast and the
// main roads stay readable under the pins (UX audit, 29 Oct 2026).
const DARK_TINT: Partial<Flavor> = {
  background: "#05171a",
  earth: "#143739",
  water: "#05171a",
  park_a: "#18443c",
  park_b: "#173f38",
  wood_a: "#18443c",
  wood_b: "#173f38",
  sand: "#1f403b",
  beach: "#1f403b",
  buildings: "#1c4547",
  minor_a: "#265254",
  minor_b: "#265254",
  major: "#33696a",
  highway: "#437c78",
};

export function searchFlavor(theme: MapTheme): Flavor {
  return theme === "dark" ? { ...namedFlavor("dark"), ...DARK_TINT } : { ...namedFlavor("light"), ...LIGHT_TINT };
}

export interface PinFeatureProps {
  id: string;
  /** 1 for an À la Une result (halo weight, cluster summary). */
  featured: 0 | 1;
}

export interface PinsCollection {
  type: "FeatureCollection";
  features: { type: "Feature"; properties: PinFeatureProps; geometry: { type: "Point"; coordinates: [number, number] } }[];
}

export function pinsCollection(pins: readonly { id: string; position: { lat: number; lng: number }; featured: boolean }[]): PinsCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      properties: { id: pin.id, featured: pin.featured ? 1 : 0 },
      geometry: { type: "Point", coordinates: [pin.position.lng, pin.position.lat] },
    })),
  };
}

export function buildSearchStyle(pmtilesUrl: string, options: { attribution?: string; theme: MapTheme; pins: PinsCollection }): StyleSpecification {
  const style = buildHouseStyle(pmtilesUrl, { attribution: options.attribution, regions: false, flavor: searchFlavor(options.theme) });
  style.sources[PINS_SOURCE] = {
    type: "geojson",
    data: options.pins,
    cluster: true,
    clusterRadius: CLUSTER_RADIUS_PX,
    clusterMaxZoom: SEARCH_ZOOM.clusterMax,
  };
  // Where the offers gather: a warm wash under the pins, no line drawn.
  style.layers.push({
    id: HALO_LAYER,
    type: "heatmap",
    source: PINS_SOURCE,
    paint: {
      "heatmap-weight": ["case", ["has", "point_count"], ["min", 1, ["/", ["get", "point_count"], 8]], 0.3],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], SEARCH_ZOOM.min, 24, SEARCH_ZOOM.max, 70],
      "heatmap-intensity": 0.8,
      "heatmap-opacity": options.theme === "dark" ? 0.4 : 0.55,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(210,162,76,0)", 0.3, "rgba(210,162,76,0.18)", 1, "rgba(192,88,44,0.32)"],
    },
  });
  return style;
}
