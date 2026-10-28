// URL list of the load test (phase 6, D17), read by load/k6.js: the SSR page paths (never rendered
// before the run) and the search query strings, from the same generator as the data set
// (src/lib/loadtest/data.ts). It imports the app's config through "@/": bundle it first, as
// .github/workflows/load-test.yml does:
//
//   npx esbuild scripts/load-urls.ts --bundle --platform=node --format=esm --outfile=<tmp>/load-urls.mjs
//   node <tmp>/load-urls.mjs > urls.json

import { loadtestPagePaths, loadtestSearchQueries } from "@/lib/loadtest/data";

/** Searches the 4-minute search scenario can send at 50 a second, with room to spare. */
export const SEARCH_QUERIES = 15_000;

process.stdout.write(JSON.stringify({ pages: loadtestPagePaths(), searches: loadtestSearchQueries(SEARCH_QUERIES) }));
