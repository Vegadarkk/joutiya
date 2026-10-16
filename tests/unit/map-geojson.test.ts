import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOROCCO_BBOX, REGIONS } from "@/config/regions";
import { polygonsOf, ringsOf, type RegionsFeatureCollection } from "@/lib/map/geojson-types";
import { REGIONS_GEOJSON } from "@/lib/map/regions-geojson";

const PATH = new URL("../../src/config/geo/regions.geojson", import.meta.url);
const file = JSON.parse(readFileSync(PATH, "utf8")) as RegionsFeatureCollection;

describe("src/config/geo/regions.geojson", () => {
  it("is a FeatureCollection of the 12 regions with our codes and slugs", () => {
    expect(file.type).toBe("FeatureCollection");
    expect(file.features).toHaveLength(12);
    const codes = file.features.map((f) => f.properties.code);
    expect(new Set(codes).size).toBe(12);
    expect(codes).toEqual(REGIONS.map((r) => r.code));
    for (const feature of file.features) {
      expect(feature.type).toBe("Feature");
      const region = REGIONS.find((r) => r.code === feature.properties.code);
      expect(region?.slug).toBe(feature.properties.slug);
      expect(Object.keys(feature.properties).sort()).toEqual(["code", "slug"]);
    }
  });

  it("carries the ODbL attribution of the source", () => {
    expect(file.attribution).toContain("OpenStreetMap contributors");
    expect(file.attribution).toContain("geoBoundaries");
    expect(file.license).toContain("ODbL");
    expect(file.source).toMatch(/^https:\/\/media\.githubusercontent\.com\/media\/wmgeolab\/geoBoundaries\//);
  });

  it("holds valid Polygon or MultiPolygon geometries with closed rings and 3-decimal coordinates", () => {
    for (const feature of file.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(feature.geometry.type);
      const polygons = polygonsOf(feature.geometry);
      expect(polygons.length).toBeGreaterThan(0);
      for (const polygon of polygons) expect(polygon.length).toBeGreaterThan(0);
      for (const ring of ringsOf(feature.geometry)) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        for (const position of ring) {
          expect(position).toHaveLength(2);
          for (const value of position) expect(Math.round(value * 1000) / 1000).toBe(value);
        }
      }
    }
  });

  it("stays inside MOROCCO_BBOX and covers the whole country, southern regions included", () => {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const feature of file.features) {
      for (const ring of ringsOf(feature.geometry)) {
        for (const [lng, lat] of ring) {
          expect(lng).toBeGreaterThanOrEqual(MOROCCO_BBOX.west);
          expect(lng).toBeLessThanOrEqual(MOROCCO_BBOX.east);
          expect(lat).toBeGreaterThanOrEqual(MOROCCO_BBOX.south);
          expect(lat).toBeLessThanOrEqual(MOROCCO_BBOX.north);
          west = Math.min(west, lng);
          east = Math.max(east, lng);
          south = Math.min(south, lat);
          north = Math.max(north, lat);
        }
      }
    }
    // Tangier in the north, Lagouira in the south, the Atlantic coast and the Oriental border.
    expect(north).toBeGreaterThan(35.8);
    expect(south).toBeLessThan(21);
    expect(west).toBeLessThan(-17);
    expect(east).toBeGreaterThan(-1.1);
    const dakhla = file.features.find((f) => f.properties.code === "12")!;
    const lats = ringsOf(dakhla.geometry).flatMap((ring) => ring.map(([, lat]) => lat));
    expect(Math.min(...lats)).toBeLessThan(21);
    expect(Math.max(...lats)).toBeGreaterThan(24.5);
  });

  it("weighs at most 80 KB", () => {
    expect(statSync(PATH).size).toBeLessThanOrEqual(80 * 1024);
  });

  it("is mirrored exactly by src/lib/map/regions-geojson.ts", () => {
    expect(REGIONS_GEOJSON).toEqual(file);
  });
});
