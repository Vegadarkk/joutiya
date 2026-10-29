// Checks what `next build` prerendered (.next/prerender-manifest.json), run right after it by
// `npm run build` (CI, Docker image):
//   node scripts/check-prerender.ts
// - Pages rendered on their first visit only (the home): no path built ahead, and an on-demand ISR
//   route (fallback null: rendered on the first request, then cached). The image is built without
//   a search engine, so a build-time home has no listing sections, and after each deploy the purged
//   edge would cache it. A parent's generateStaticParams (the (public) layout) would prerender them
//   whatever the page returns (localeParams, src/i18n/params.ts).
// - Pages built ahead: every locale prerendered (they list their locales themselves).

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES } from "../src/config/site.ts";

/** The parts of the prerender manifest read here. */
export interface PrerenderManifest {
  routes: Record<string, { srcRoute?: string | null }>;
  dynamicRoutes: Record<string, { fallback?: string | false | null }>;
}

/** Rendered on the first visit, never at build. */
export const FIRST_VISIT_ROUTES: readonly string[] = ["/[locale]"];

/** Built ahead, in every locale. */
export const BUILT_AHEAD_ROUTES: readonly string[] = ["/[locale]/aide", "/[locale]/aide/[slug]", "/[locale]/demarches", "/[locale]/demarches/[rubric]", "/[locale]/legal/[page]"];

/** The source route of a prerendered path: its srcRoute, or itself for a route without params. */
function sourceOf(path: string, route: { srcRoute?: string | null }): string {
  return route.srcRoute ?? path;
}

export function prerenderProblems(manifest: PrerenderManifest, locales: readonly string[] = LOCALES): string[] {
  const problems: string[] = [];
  const built = Object.entries(manifest.routes);
  for (const route of FIRST_VISIT_ROUTES) {
    const paths = built.filter(([path, entry]) => sourceOf(path, entry) === route).map(([path]) => path);
    if (paths.length > 0) problems.push(`${route} must not be prerendered at build, got ${paths.join(", ")}`);
    const dynamic = manifest.dynamicRoutes[route];
    if (!dynamic) problems.push(`${route} is not an ISR route (missing from dynamicRoutes)`);
    else if (dynamic.fallback !== null) problems.push(`${route} must render on its first request (fallback null), got ${JSON.stringify(dynamic.fallback)}`);
  }
  for (const route of BUILT_AHEAD_ROUTES) {
    for (const locale of locales) {
      const prefix = `/${locale}`;
      const found = built.some(([path, entry]) => sourceOf(path, entry) === route && (path === prefix || path.startsWith(`${prefix}/`)));
      if (!found) problems.push(`${route} has no page prerendered in ${locale}`);
    }
  }
  return problems;
}

function main(): void {
  const file = join(fileURLToPath(new URL("..", import.meta.url)), ".next/prerender-manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as PrerenderManifest;
  const problems = prerenderProblems(manifest);
  if (problems.length > 0) {
    console.error(`prerender check failed:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`prerender check: ${FIRST_VISIT_ROUTES.length} first-visit route(s), ${BUILT_AHEAD_ROUTES.length} built-ahead route(s) OK`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]check-prerender\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) main();
