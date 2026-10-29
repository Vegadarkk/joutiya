import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILT_AHEAD_ROUTES, prerenderProblems, type PrerenderManifest } from "./check-prerender.ts";

const LOCALES = ["fr", "ar"];

/** A build that is right: the home on demand, every built-ahead route in both locales. */
function goodManifest(): PrerenderManifest {
  const routes: PrerenderManifest["routes"] = {};
  for (const route of BUILT_AHEAD_ROUTES) {
    for (const locale of LOCALES) routes[route.replace("[locale]", locale).replace(/\[\w+\]/g, "x")] = { srcRoute: route };
  }
  return { routes, dynamicRoutes: { "/[locale]": { fallback: null } } };
}

test("a build with the home on demand and the built-ahead pages in every locale passes", () => {
  assert.deepEqual(prerenderProblems(goodManifest(), LOCALES), []);
});

test("a home prerendered at build fails (the layout's locales would do it)", () => {
  const manifest = goodManifest();
  manifest.routes["/fr"] = { srcRoute: "/[locale]" };
  manifest.routes["/ar"] = { srcRoute: "/[locale]" };
  assert.deepEqual(prerenderProblems(manifest, LOCALES), ["/[locale] must not be prerendered at build, got /fr, /ar"]);
});

test("a home that is not ISR on demand fails", () => {
  const missing = goodManifest();
  missing.dynamicRoutes = {};
  assert.match(prerenderProblems(missing, LOCALES).join(), /missing from dynamicRoutes/);
  const fallback = goodManifest();
  fallback.dynamicRoutes["/[locale]"] = { fallback: false };
  assert.match(prerenderProblems(fallback, LOCALES).join(), /fallback null/);
});

test("a built-ahead page missing a locale fails", () => {
  const manifest = goodManifest();
  delete manifest.routes["/ar/aide"];
  assert.deepEqual(prerenderProblems(manifest, LOCALES), ["/[locale]/aide has no page prerendered in ar"]);
});
