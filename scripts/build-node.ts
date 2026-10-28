// Bundles the Node entry points that run outside Next.js into dist/ (ESM files): the BullMQ
// worker, the CSP hash hook preloaded by the web server, and the target guard.
// Run after `next build`; the Docker image copies dist/ next to the standalone server.
//
// The worker keeps its npm packages external: firebase-admin (google-gax) reads proto files and
// __dirname at runtime and cannot be bundled. Its runtime files are traced into
// dist/worker-standalone/ (same layout as .next/standalone), which the worker image copies whole.

import { build, type BuildOptions } from "esbuild";
import { nodeFileTrace } from "@vercel/nft";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const common: BuildOptions = {
  absWorkingDir: root,
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "linked",
  legalComments: "none",
  tsconfig: "tsconfig.json",
  // "server-only" throws outside React Server Components; these bundles are server code by definition.
  alias: { "server-only": "./src/lib/empty.ts" },
  logLevel: "info",
};

// Self-contained: the hook runs in the web image, whose node_modules is Next's traced subset.
await build({
  ...common,
  entryPoints: {
    "server/csp-hash-hook": "src/server/csp-hash-hook.ts",
    "assert-target": "scripts/assert-target.ts",
  },
  // CommonJS code calls require() on Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

await build({
  ...common,
  // Search scripts run in the worker image (design D3, D12): `node dist/worker/reindex-search.mjs`,
  // `node dist/worker/search-setup.mjs` (with the master key of meilisearch.env in its environment);
  // so do the P0 drill (phase 6 D16): `node dist/worker/alert-drill.mjs`, and the load test data
  // set (D17): `node dist/worker/seed-loadtest.mjs`.
  entryPoints: {
    "worker/index": "src/worker/index.ts",
    "worker/reindex-search": "scripts/reindex-search.ts",
    "worker/search-setup": "scripts/search-setup.ts",
    "worker/alert-drill": "scripts/alert-drill.ts",
    "worker/seed-loadtest": "scripts/seed-loadtest.ts",
  },
  packages: "external",
  // The web server revalidates ISR pages itself; Node cannot import "next/cache" from the worker.
  alias: { ...common.alias, "next/cache": "./src/lib/next-cache-outside-next.ts" },
});

const worker = "dist/worker/index.mjs";
const { fileList, warnings } = await nodeFileTrace([worker, "dist/worker/reindex-search.mjs", "dist/worker/search-setup.mjs", "dist/worker/alert-drill.mjs", "dist/worker/seed-loadtest.mjs"], { base: root });
for (const warning of warnings) {
  // Expected: optional dependencies that are not installed, and non-JS assets (proto LICENSE files).
  if (!/Cannot find module|Failed to resolve dependency|Failed to parse/.test(warning.message)) console.warn(`trace: ${warning.message}`);
}

const out = join(root, "dist/worker-standalone");
rmSync(out, { recursive: true, force: true });
cpSync(join(root, "dist/worker"), join(out, "dist/worker"), { recursive: true });
let count = 0;
for (const file of fileList) {
  if (!file.startsWith("node_modules/")) continue;
  const target = join(out, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target, { dereference: true });
  count += 1;
}
console.log(`worker-standalone: ${count} files from node_modules`);
