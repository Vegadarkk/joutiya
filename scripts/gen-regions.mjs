// Regenerates src/config/geo/regions-data.ts from scripts/data/regions-cities.json (phase 3 dataset:
// 12 regions in décret 2.15.40 order, 100 cities, Wikidata coordinates and populations).
//   node scripts/gen-regions.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "scripts/data/regions-cities.json"), "utf8"));
const q = (s) => JSON.stringify(s);

let out = `// Generated from scripts/data/regions-cities.json by scripts/gen-regions.mjs. Do not edit by hand.
// Coordinates: Wikidata P625 rounded to 4 decimals; populations: Wikidata P1082 latest (mostly the 2024
// census). Region order = décret 2.15.40 (codes 01-12). Arabic names are the Wikidata labels, hyphenated
// and without the leading "جهة". Licence: CC0 (Wikidata).

export interface RegionData {
  code: string;
  slug: string;
  nameFr: string;
  nameAr: string;
  /** Slug of the chef-lieu city. */
  chefLieu: string;
  /** Wikidata P625 of the region item: a representative point, not a geometric centroid. */
  centroid: { lat: number; lng: number };
}

export interface CityData {
  slug: string;
  nameFr: string;
  nameAr: string;
  regionCode: string;
  lat: number;
  lng: number;
  /** Shown first in the city picker (large cities and region capitals). */
  major: boolean;
  /** Latest Wikidata population (census or communal figure). */
  population: number;
}

export const REGIONS_DATA: readonly RegionData[] = [
`;
for (const r of data.regions) {
  out += `  { code: ${q(r.code)}, slug: ${q(r.slug)}, nameFr: ${q(r.nameFr)}, nameAr: ${q(r.nameAr)}, chefLieu: ${q(r.chefLieu)}, centroid: { lat: ${r.centroid.lat}, lng: ${r.centroid.lng} } },\n`;
}
out += `];

export const CITIES_DATA: readonly CityData[] = [
`;
for (const c of data.cities) {
  out += `  { slug: ${q(c.slug)}, nameFr: ${q(c.nameFr)}, nameAr: ${q(c.nameAr)}, regionCode: ${q(c.regionCode)}, lat: ${c.lat}, lng: ${c.lng}, major: ${c.major}, population: ${c.population} },\n`;
}
out += `];\n`;

writeFileSync(join(root, "src/config/geo/regions-data.ts"), out);
console.log(`regions-data.ts: ${data.regions.length} regions, ${data.cities.length} cities`);
