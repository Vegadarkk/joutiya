import { describe, expect, it } from "vitest";
import maplibrePackage from "maplibre-gl/package.json";
import {
  APPROX_SOURCE,
  attributionHtml,
  basemapLayers,
  buildHouseStyle,
  HOUSE_LAYERS,
  MAP_ATTRIBUTION_TEXT,
  MAP_ZOOM,
  MAPLIBRE_VERSION,
  MAPLIBRE_WORKER_URL,
  PROTOMAPS_SOURCE,
  REGIONS_SOURCE,
} from "@/lib/map/style";

const URL = "https://media.example.test/maps/morocco.pmtiles";

describe("buildHouseStyle", () => {
  const style = buildHouseStyle(URL, { approx: { lng: -7.59, lat: 33.57 } });
  const serialized = JSON.stringify(style);

  it("reads the archive through the pmtiles protocol with the OSM attribution", () => {
    const source = style.sources[PROTOMAPS_SOURCE];
    expect(source?.type).toBe("vector");
    expect(source && "url" in source ? source.url : undefined).toBe(`pmtiles://${URL}`);
    expect(source && "attribution" in source ? source.attribution : undefined).toContain("https://www.openstreetmap.org/copyright");
    expect(style.version).toBe(8);
  });

  it("draws no boundary from the tiles: no layer uses the boundaries source layer", () => {
    for (const layer of style.layers) {
      expect("source-layer" in layer ? layer["source-layer"] : undefined).not.toBe("boundaries");
      expect(layer.id).not.toMatch(/boundar/);
    }
    expect(basemapLayers().length).toBeGreaterThan(40);
  });

  it("renders no text: no symbol layer, no lang, no glyphs or sprite origin", () => {
    expect(style.layers.some((layer) => layer.type === "symbol")).toBe(false);
    expect(serialized).not.toContain("text-field");
    expect(serialized).not.toContain('"lang"');
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    // Every URL of the style points at the archive: nothing else is fetched (the regions GeoJSON only
    // carries its licence notice; the attribution holds the two copyright links).
    const withoutRegions = JSON.stringify({ ...style, sources: { ...style.sources, [REGIONS_SOURCE]: undefined } });
    expect(withoutRegions.match(/https?:\/\/[^"\\]+/g)?.filter((u) => !u.startsWith("https://www.openstreetmap.org") && !u.startsWith("https://protomaps.com"))).toEqual([URL]);
  });

  it("puts our regions and the approximate area above the basemap", () => {
    const ids = style.layers.map((layer) => layer.id);
    expect(ids.at(-2)).toBe(HOUSE_LAYERS.regions);
    expect(ids.at(-1)).toBe(HOUSE_LAYERS.approx);
    const regions = style.sources[REGIONS_SOURCE];
    expect(regions?.type).toBe("geojson");
    expect(regions && "data" in regions && typeof regions.data === "object" && "features" in regions.data ? regions.data.features : []).toHaveLength(12);
    const approx = style.sources[APPROX_SOURCE];
    expect(JSON.stringify(approx)).toContain("[-7.59,33.57]");
    const circle = style.layers.at(-1)!;
    expect(circle.type).toBe("circle");
    // Exponential zoom interpolation base 2 keeps the circle ~600 m wide at every zoom.
    const radius = circle.type === "circle" ? circle.paint?.["circle-radius"] : undefined;
    expect(radius).toEqual(["interpolate", ["exponential", 2], ["zoom"], MAP_ZOOM.min, expect.any(Number), MAP_ZOOM.max, expect.any(Number)]);
    const stops = radius as unknown[];
    expect(stops[6] as number).toBeGreaterThan(30);
    expect(stops[6] as number).toBeLessThan(60);
  });

  it("omits the approximate area when no position is given", () => {
    const bare = buildHouseStyle(URL);
    expect(bare.sources[APPROX_SOURCE]).toBeUndefined();
    expect(bare.layers.at(-1)?.id).toBe(HOUSE_LAYERS.regions);
  });
});

describe("attributionHtml", () => {
  it("links the two known names and escapes the rest", () => {
    const html = attributionHtml(MAP_ATTRIBUTION_TEXT);
    expect(html).toContain('<a href="https://www.openstreetmap.org/copyright"');
    expect(html).toContain('<a href="https://protomaps.com"');
    expect(attributionHtml("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("MapLibre worker", () => {
  it("is pinned to the installed version (scripts/copy-vendor.mjs publishes that file name)", () => {
    expect(MAPLIBRE_VERSION).toBe(maplibrePackage.version);
    expect(MAPLIBRE_WORKER_URL).toBe(`/vendor/maplibre-gl-${maplibrePackage.version}-worker.mjs`);
  });
});
