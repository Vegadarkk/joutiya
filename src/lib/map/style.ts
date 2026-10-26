// House style of the interactive map (D10): Protomaps "light" flavour over our PMTiles extract, without
// any `boundaries` layer (the tiles carry disputed lines and a foreign country label in the south), with
// the 12 regions drawn from our GeoJSON and the listing's approximate area as a circle. No text layer, so
// the style needs neither glyphs nor sprites (no external origin for the CSP).

import { layers, namedFlavor } from "@protomaps/basemaps";
import { version as maplibreVersion } from "maplibre-gl/package.json";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";
import { metersPerPixel } from "./projection";
import { REGIONS_GEOJSON } from "./regions-geojson";

export const PROTOMAPS_SOURCE = "protomaps";
export const REGIONS_SOURCE = "joutiya-regions";
export const APPROX_SOURCE = "joutiya-approx";

/** Ids of our own layers, above the basemap. */
export const HOUSE_LAYERS = { regions: "joutiya-regions-line", approx: "joutiya-approx-area" } as const;

/** Zoom range: the extract stops at z12 (MapLibre overzooms a little); street-level detail stays hidden. */
export const MAP_ZOOM = { min: 5, max: 12.4, listing: 12 } as const;

/** Radius of the approximate area shown around the (already offset) position, metres. */
export const APPROX_RADIUS_METERS = 600;

/** Worker file copied by scripts/copy-vendor.mjs into public/vendor (CSP: worker-src 'self'); the version is
 * read from the installed package, so a MapLibre bump never needs a second edit here. */
export const MAPLIBRE_VERSION: string = maplibreVersion;
export const MAPLIBRE_WORKER_URL = `/vendor/maplibre-gl-${MAPLIBRE_VERSION}-worker.mjs`;

/** Plain-text attribution, identical to publicConfig.map.attribution (src/lib/config/public.ts). */
export const MAP_ATTRIBUTION_TEXT = "© OpenStreetMap contributors · Protomaps";

// Brand tokens (src/styles/globals.css): MapLibre paints cannot read CSS variables.
const OCHRE_500 = "#c0582c";
const BAB_500 = "#1f6a69";

export interface HouseStyleOptions {
  /** Plain text; the two known names become links in the attribution control. */
  attribution?: string;
  /** Approximate position of the listing (never the exact point) and the drawn radius. */
  approx?: { lng: number; lat: number; radiusMeters?: number };
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** HTML of the attribution control: the OSM copyright link is required by the ODbL notice. */
export function attributionHtml(text: string = MAP_ATTRIBUTION_TEXT): string {
  return escapeHtml(text)
    .replace(
      "OpenStreetMap contributors",
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    )
    .replace("Protomaps", '<a href="https://protomaps.com" target="_blank" rel="noopener noreferrer">Protomaps</a>');
}

/** Basemap layers of the light flavour without text (no `lang`) and without the `boundaries` source layer. */
export function basemapLayers(): LayerSpecification[] {
  const all = layers(PROTOMAPS_SOURCE, namedFlavor("light")) as LayerSpecification[];
  return all.filter((layer) => !("source-layer" in layer) || layer["source-layer"] !== "boundaries");
}

/** Circle radius in pixels for a ground radius, doubling per zoom level (constant size on the ground). */
function circleRadius(lat: number, radiusMeters: number): ExpressionSpecification {
  const at = (zoom: number) => Math.round((radiusMeters / metersPerPixel(lat, zoom)) * 100) / 100;
  return ["interpolate", ["exponential", 2], ["zoom"], MAP_ZOOM.min, at(MAP_ZOOM.min), MAP_ZOOM.max, at(MAP_ZOOM.max)];
}

export function buildHouseStyle(pmtilesUrl: string, options: HouseStyleOptions = {}): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {
      [PROTOMAPS_SOURCE]: { type: "vector", url: `pmtiles://${pmtilesUrl}`, attribution: attributionHtml(options.attribution) },
      [REGIONS_SOURCE]: { type: "geojson", data: REGIONS_GEOJSON },
    },
    layers: [
      ...basemapLayers(),
      {
        id: HOUSE_LAYERS.regions,
        type: "line",
        source: REGIONS_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": OCHRE_500,
          "line-width": ["interpolate", ["linear"], ["zoom"], MAP_ZOOM.min, 1, MAP_ZOOM.max, 2.5],
          "line-opacity": 0.8,
        },
      },
    ],
  };
  if (options.approx) {
    const { lng, lat, radiusMeters = APPROX_RADIUS_METERS } = options.approx;
    style.sources[APPROX_SOURCE] = {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } },
    };
    style.layers.push({
      id: HOUSE_LAYERS.approx,
      type: "circle",
      source: APPROX_SOURCE,
      paint: {
        "circle-radius": circleRadius(lat, radiusMeters),
        "circle-color": BAB_500,
        "circle-opacity": 0.18,
        "circle-stroke-color": BAB_500,
        "circle-stroke-width": 2,
        "circle-stroke-opacity": 0.9,
        "circle-pitch-alignment": "map",
      },
    });
  }
  return style;
}
