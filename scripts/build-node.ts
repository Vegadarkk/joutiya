// Bundles the Node entry points that run outside Next.js into dist/ (single ESM files):
// the BullMQ worker, the CSP hash hook preloaded by the web server, and the target guard.
// Run after `next build`; the Docker image copies dist/ next to the standalone server.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: {
    "worker/index": "src/worker/index.ts",
    "server/csp-hash-hook": "src/server/csp-hash-hook.ts",
    "assert-target": "scripts/assert-target.ts",
  },
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
  // CommonJS dependencies (ioredis) call require() on Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
