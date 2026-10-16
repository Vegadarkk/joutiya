// Copies browser assets that must be served from our own origin into public/vendor/ (gitignored):
// the MapLibre worker (CSP `worker-src 'self'`; under a bundler MapLibre cannot derive its worker URL, so
// src/lib/map/style.ts points at this versioned file). Run before dev and build (package.json
// `predev` / `prebuild`); idempotent.
//   node scripts/copy-vendor.mjs

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const outDir = join(root, "public", "vendor");

const maplibreDir = dirname(require.resolve("maplibre-gl/package.json"));
const { version } = JSON.parse(readFileSync(join(maplibreDir, "package.json"), "utf8"));

/** [source, published name]: the name carries the version so caches never serve a stale worker. */
const FILES = [[join(maplibreDir, "dist", "maplibre-gl-worker.mjs"), `maplibre-gl-${version}-worker.mjs`]];

mkdirSync(outDir, { recursive: true });
for (const [source, name] of FILES) {
  copyFileSync(source, join(outDir, name));
  console.log(`public/vendor/${name}`);
}
