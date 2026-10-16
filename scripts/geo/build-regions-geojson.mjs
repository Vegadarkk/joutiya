// Builds src/config/geo/regions.geojson (the 12 regions of Morocco, design D10) from the geoBoundaries
// gbOpen MAR ADM1 file, plus the TypeScript mirror src/lib/map/regions-geojson.ts that the app imports
// (bundlers cannot import a .geojson file; the unit test keeps both files identical).
//
//   node scripts/geo/build-regions-geojson.mjs <input.geojson> [--tolerance 0.003] [--out <path>] [--no-ts]
//
// Input (fetch into a fresh scratch directory, never into the repo; pinned commit 9469f09, 1,736,594 bytes,
// sha256 6c4e3e25ecade3d00530faa820dcf3fecec4728218089a34bcb922bdb29c129f):
//   https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/MAR/ADM1/geoBoundaries-MAR-ADM1.geojson
// Licence of the source: ODbL 1.0 (OpenStreetMap contributors, via Wambacher 2017, built by geoBoundaries
// 2023-12-12). The output is a derivative database: the attribution travels in the file itself.
//
// Matching table geoBoundaries -> Joutiya codes (décret 2.15.40 order; ISO 3166-2:MA follows the same order,
// so `shapeISO` is the primary key and the English `shapeName` is checked against our slug as a guard):
//   MA-01 "Tangier-Tetouan-Al Hoceima" -> 01 tanger-tetouan-al-hoceima
//   MA-02 "Oriental"                   -> 02 oriental
//   MA-03 "Fez-Meknes"                 -> 03 fes-meknes
//   MA-04 "Rabat-Salé-Kenitra"         -> 04 rabat-sale-kenitra
//   MA-05 "Béni Mellal-Khénifra"       -> 05 beni-mellal-khenifra
//   MA-06 "Casablanca-Settat"          -> 06 casablanca-settat
//   MA-07 "Marrakech-Safi"             -> 07 marrakech-safi
//   MA-08 "Drâa-Tafilalet"             -> 08 draa-tafilalet
//   MA-09 "Souss-Massa"                -> 09 souss-massa
//   MA-10 "Guelmim-Oued Noun"          -> 10 guelmim-oued-noun          (southern region)
//   MA-11 "Laâyoune-Sakia El Hamra"    -> 11 laayoune-sakia-el-hamra    (southern region, lat 24.4..28.2)
//   MA-12 "Dakhla-Oued Ed-Dahab"       -> 12 dakhla-oued-ed-dahab       (southern region, lat 20.8..24.7)
// The three southern regions are Moroccan regions in geoBoundaries as in décret 2.15.40: the file draws the
// country in its territorial integrity (architecture §2, "Cartes").
//
// Simplification: Douglas-Peucker per ring, then a second pass keeps every vertex that ANY ring kept
// (vertices shared by two neighbouring regions have identical coordinates in the source), so shared borders
// stay identical on both sides and no hairline gap opens. Coordinates are rounded to 3 decimals (~110 m).

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_URL =
  "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/MAR/ADM1/geoBoundaries-MAR-ADM1.geojson";
const MAX_BYTES = 80 * 1024;
const DECIMALS = 3;

/** shapeISO -> { code, slug, geoBoundaries English name }. */
const MATCHING = [
  ["MA-01", "01", "tanger-tetouan-al-hoceima", "Tangier-Tetouan-Al Hoceima"],
  ["MA-02", "02", "oriental", "Oriental"],
  ["MA-03", "03", "fes-meknes", "Fez-Meknes"],
  ["MA-04", "04", "rabat-sale-kenitra", "Rabat-Salé-Kenitra"],
  ["MA-05", "05", "beni-mellal-khenifra", "Béni Mellal-Khénifra"],
  ["MA-06", "06", "casablanca-settat", "Casablanca-Settat"],
  ["MA-07", "07", "marrakech-safi", "Marrakech-Safi"],
  ["MA-08", "08", "draa-tafilalet", "Drâa-Tafilalet"],
  ["MA-09", "09", "souss-massa", "Souss-Massa"],
  ["MA-10", "10", "guelmim-oued-noun", "Guelmim-Oued Noun"],
  ["MA-11", "11", "laayoune-sakia-el-hamra", "Laâyoune-Sakia El Hamra"],
  ["MA-12", "12", "dakhla-oued-ed-dahab", "Dakhla-Oued Ed-Dahab"],
];

function parseArgs(argv) {
  const args = { tolerance: 0.003, out: join(root, "src/config/geo/regions.geojson"), ts: join(root, "src/lib/map/regions-geojson.ts") };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--no-ts") args.ts = null;
    else rest.push(a);
  }
  if (rest.length !== 1 || !Number.isFinite(args.tolerance) || args.tolerance <= 0) {
    console.error("usage: node scripts/geo/build-regions-geojson.mjs <input.geojson> [--tolerance 0.003] [--out <path>] [--no-ts]");
    process.exit(2);
  }
  args.input = resolve(rest[0]);
  return args;
}

/** Douglas-Peucker on an open polyline: returns the keep mask (ends always kept). */
function douglasPeuckerMask(points, tolerance) {
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let maxDist = -1;
    let index = -1;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > maxDist) {
        maxDist = d2;
        index = i;
      }
    }
    if (maxDist > tol2) {
      keep[index] = true;
      stack.push([a, index], [index, b]);
    }
  }
  return keep;
}

const key = (p) => `${p[0]},${p[1]}`;

/** Rings of every feature share one "kept" set, so shared borders simplify identically. */
function simplifyShared(features, tolerance) {
  const kept = new Set();
  for (const f of features) {
    for (const ring of f.rings) {
      // Closed ring: run DP on the open polyline, and also keep the farthest point from the start so a
      // ring never collapses to a segment.
      const open = ring.slice(0, -1);
      const mask = douglasPeuckerMask(open, tolerance);
      let far = 0;
      let farDist = -1;
      for (let i = 1; i < open.length; i++) {
        const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
        if (d > farDist) {
          farDist = d;
          far = i;
        }
      }
      mask[far] = true;
      open.forEach((p, i) => mask[i] && kept.add(key(p)));
    }
  }
  return features.map((f) => ({
    ...f,
    rings: f.rings
      .map((ring) => {
        const pts = ring.slice(0, -1).filter((p) => kept.has(key(p)));
        return pts.length >= 3 ? pts : [];
      })
      .filter((r) => r.length > 0),
  }));
}

const round = (v) => Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS;

function finishRing(points) {
  const out = [];
  for (const p of points) {
    const q = [round(p[0]), round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  else if (out.length === 1) out.push([first[0], first[1]]);
  // A valid ring has at least 4 positions (3 distinct + closure).
  return out.length >= 4 ? out : null;
}

function polygonsOf(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`unsupported geometry ${geometry.type}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(args.input, "utf8"));
  if (input.type !== "FeatureCollection" || !Array.isArray(input.features)) throw new Error("input is not a FeatureCollection");
  if (input.features.length !== 12) throw new Error(`expected 12 ADM1 features, got ${input.features.length}`);

  const byIso = new Map(MATCHING.map(([iso, code, slug, name]) => [iso, { code, slug, name }]));
  const seen = new Set();
  // Flatten to [{ code, slug, rings (one array per ring, outer and holes kept in order), polygonRingCounts }].
  const flat = input.features.map((feature) => {
    const iso = feature.properties?.shapeISO;
    const match = byIso.get(iso);
    if (!match) throw new Error(`unknown shapeISO ${iso}`);
    if (feature.properties.shapeName !== match.name) {
      throw new Error(`name mismatch for ${iso}: ${feature.properties.shapeName} (expected ${match.name})`);
    }
    if (seen.has(iso)) throw new Error(`duplicate ${iso}`);
    seen.add(iso);
    const polygons = polygonsOf(feature.geometry);
    return { code: match.code, slug: match.slug, polygons: polygons.map((p) => p.length), rings: polygons.flat() };
  });

  const before = flat.reduce((n, f) => n + f.rings.reduce((m, r) => m + r.length, 0), 0);
  const simplified = simplifyShared(flat, args.tolerance);

  const features = simplified
    .map((f) => {
      // Rebuild polygons: ring i of the flat list belongs to the polygon whose cumulative count covers i.
      const polygons = [];
      let cursor = 0;
      for (const count of f.polygons) {
        const rings = [];
        for (let i = 0; i < count; i++) {
          const ring = f.rings[cursor++];
          const finished = ring ? finishRing(ring) : null;
          if (finished) rings.push(finished);
        }
        // Drop a polygon whose outer ring vanished (its holes mean nothing without it).
        if (rings.length) polygons.push(rings);
      }
      if (!polygons.length) throw new Error(`region ${f.code} collapsed`);
      const geometry = polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
      return { type: "Feature", properties: { code: f.code, slug: f.slug }, geometry };
    })
    .sort((a, b) => a.properties.code.localeCompare(b.properties.code));

  const after = features.reduce((n, f) => n + polygonsOf(f.geometry).flat().reduce((m, r) => m + r.length, 0), 0);

  const collection = {
    type: "FeatureCollection",
    attribution: "© OpenStreetMap contributors · geoBoundaries (gbOpen MAR ADM1, 2017 OSM/Wambacher data)",
    license: "ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)",
    source: SOURCE_URL,
    features,
  };

  // One feature per line keeps diffs readable; coordinates stay compact.
  const json = `{\n  "type": "FeatureCollection",\n  "attribution": ${JSON.stringify(collection.attribution)},\n  "license": ${JSON.stringify(collection.license)},\n  "source": ${JSON.stringify(collection.source)},\n  "features": [\n${features.map((f) => `    ${JSON.stringify(f)}`).join(",\n")}\n  ]\n}\n`;
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_BYTES) throw new Error(`output is ${bytes} bytes (> ${MAX_BYTES}); raise --tolerance`);
  writeFileSync(args.out, json);

  if (args.ts) {
    const ts = `// Generated by scripts/geo/build-regions-geojson.mjs from src/config/geo/regions.geojson. Do not edit.
// Mirror of the GeoJSON file for the bundler (a .geojson file cannot be imported); the unit test
// tests/unit/map-geojson.test.ts fails when the two drift. Licence: ODbL 1.0, see the attribution field.

import type { RegionsFeatureCollection } from "./geojson-types";

export const REGIONS_GEOJSON: RegionsFeatureCollection = {
  type: "FeatureCollection",
  attribution: ${JSON.stringify(collection.attribution)},
  license: ${JSON.stringify(collection.license)},
  source: ${JSON.stringify(collection.source)},
  features: [
${features.map((f) => `    ${JSON.stringify(f)},`).join("\n")}
  ],
};
`;
    writeFileSync(args.ts, ts);
  }

  console.log(
    `regions.geojson: ${features.length} features, ${before} -> ${after} vertices (tolerance ${args.tolerance} deg, ${DECIMALS} decimals), ${bytes} bytes` +
      ` (${statSync(args.out).size} on disk), limit ${MAX_BYTES}`,
  );
}

main();
