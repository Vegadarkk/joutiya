// Resolves every package import of the worker bundles the way Node's ESM loader does at startup,
// from dist/worker-standalone (the worker image's /app). A specifier Node cannot resolve there
// (a missing traced file, or a deep import such as "next/cache" into a package without an exports
// map) crash-loops the worker with ERR_MODULE_NOT_FOUND. Run after `node scripts/build-node.ts`:
//   node --experimental-import-meta-resolve scripts/check-worker-imports.ts
// (the flag lets import.meta.resolve take the bundle as parent). import.meta.resolve does not check
// that the file exists, and Node's ESM loader never adds an extension, hence the existsSync below.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "dist/worker-standalone/dist/worker");
const bundles = readdirSync(dir).filter((file) => file.endsWith(".mjs"));
if (bundles.length === 0) throw new Error(`no bundle in ${dir}: run node scripts/build-node.ts first`);

const IMPORT = /(?:^|[\s;])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"'.][^"']*)["']|\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g;
const failures: string[] = [];
for (const bundle of bundles) {
  const parent = pathToFileURL(join(dir, bundle)).href;
  const specifiers = new Set<string>();
  for (const match of readFileSync(join(dir, bundle), "utf8").matchAll(IMPORT)) specifiers.add(match[1] ?? match[2] ?? "");
  for (const specifier of specifiers) {
    if (specifier === "" || specifier.startsWith("node:")) continue;
    let path: string;
    try {
      path = fileURLToPath(import.meta.resolve(specifier, parent));
    } catch (error) {
      failures.push(`${bundle}: ${specifier} (${(error as { code?: string }).code ?? String(error)})`);
      continue;
    }
    if (!path.startsWith(join(root, "dist/worker-standalone/"))) throw new Error(`${specifier} resolved outside the standalone tree: run with --experimental-import-meta-resolve`);
    if (!existsSync(path) || !statSync(path).isFile()) failures.push(`${bundle}: ${specifier} (no file at ${path.slice(root.length)})`);
  }
  console.log(`${bundle}: ${specifiers.size} package imports checked`);
}
if (failures.length > 0) {
  console.error(`unresolvable imports:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
