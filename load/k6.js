// Load test of staging (phase 6, D17; docs/lancement/charge-procedure.md). Run by
// .github/workflows/load-test.yml with k6 v2.3.0:
//
//   k6 run --summary-mode=compact load/k6.js
//
// Scenarios (constant arrival rate, so a slow server shows as latency, not as fewer requests):
//   warmup    1 min at 5/s on the home pages (connections, JIT, caches of shared data);
//   pages     3 min at 40/s on SSR pages never rendered before (listing pages of the seeded set,
//             category x city and subcategory x city pages: ISR misses), p95 < 500 ms;
//   searches  3 min at 50/s on /api/search with the seeded words, cities, categories and sorts,
//             p95 < 300 ms.
// Each URL is used once per run (exec.scenario.iterationInTest). urls.json comes from
// scripts/load-urls.ts.
//
// Environment: TARGET (https://staging.joutiya.ma), ACCESS_HEADER and ACCESS_TOKEN (the Access
// service token in single-header mode), LOADTEST_SECRET (x-joutiya-loadtest: skips the edge rate
// limit rule and the app limiters, staging only), SUMMARY (path of the JSON summary).

import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";

// One SharedArray per list: an element is decoded on access, the whole file never per iteration.
const PAGES = new SharedArray("pages", () => JSON.parse(open("./urls.json")).pages);
const SEARCHES = new SharedArray("searches", () => JSON.parse(open("./urls.json")).searches);

const TARGET = __ENV.TARGET || "https://staging.joutiya.ma";
const headers = { "x-joutiya-loadtest": __ENV.LOADTEST_SECRET || "", "user-agent": "joutiya-loadtest/k6" };
if (__ENV.ACCESS_HEADER) headers[__ENV.ACCESS_HEADER] = __ENV.ACCESS_TOKEN || "";

export const options = {
  discardResponseBodies: true,
  scenarios: {
    warmup: { executor: "constant-arrival-rate", exec: "warmup", rate: 5, timeUnit: "1s", duration: "1m", preAllocatedVUs: 10, maxVUs: 50 },
    pages: { executor: "constant-arrival-rate", exec: "pages", startTime: "1m", rate: 40, timeUnit: "1s", duration: "3m", preAllocatedVUs: 60, maxVUs: 300 },
    searches: { executor: "constant-arrival-rate", exec: "searches", startTime: "4m", rate: 50, timeUnit: "1s", duration: "3m", preAllocatedVUs: 60, maxVUs: 300 },
  },
  thresholds: {
    // A threshold makes k6 keep the sub-metric, so the warm-up shows in the summary too.
    "http_req_duration{scenario:warmup}": ["max>=0"],
    "http_req_duration{scenario:pages}": ["p(95)<500"],
    "http_req_duration{scenario:searches}": ["p(95)<300"],
    "http_req_failed{scenario:pages}": ["rate<0.01"],
    "http_req_failed{scenario:searches}": ["rate<0.01"],
    "checks{scenario:pages}": ["rate>0.99"],
    "checks{scenario:searches}": ["rate>0.99"],
  },
};

const HOMES = ["/fr", "/ar", "/rif"];

export function warmup() {
  const response = http.get(`${TARGET}${HOMES[exec.scenario.iterationInTest % HOMES.length]}`, { headers, redirects: 0 });
  check(response, { "home 200": (r) => r.status === 200 });
}

export function pages() {
  const path = PAGES[exec.scenario.iterationInTest % PAGES.length];
  // The path is not a tag: 7 200 distinct values would blow up the metrics.
  const response = http.get(`${TARGET}${path}`, { headers, redirects: 0, tags: { name: "page" } });
  check(response, { "page 200": (r) => r.status === 200 });
}

export function searches() {
  const query = SEARCHES[exec.scenario.iterationInTest % SEARCHES.length];
  const response = http.get(`${TARGET}/api/search?${query}`, { headers, redirects: 0, tags: { name: "search" } });
  check(response, { "search 200": (r) => r.status === 200 });
}

function metric(data, name) {
  const found = data.metrics[name];
  return found ? found.values : null;
}

/** Counts and latencies only: the summary goes to a public artifact (no URL, header or secret). */
export function handleSummary(data) {
  const summary = {};
  for (const scenario of ["warmup", "pages", "searches"]) {
    summary[scenario] = {
      duration: metric(data, `http_req_duration{scenario:${scenario}}`),
      failed: metric(data, `http_req_failed{scenario:${scenario}}`),
      checks: metric(data, `checks{scenario:${scenario}}`),
    };
  }
  summary.requests = metric(data, "http_reqs");
  summary.droppedIterations = metric(data, "dropped_iterations");
  summary.thresholds = Object.fromEntries(
    Object.entries(data.metrics)
      .filter(([, value]) => value.thresholds)
      .map(([name, value]) => [name, Object.fromEntries(Object.entries(value.thresholds).map(([rule, result]) => [rule, result.ok]))]),
  );
  const json = JSON.stringify(summary, null, 2);
  return { [__ENV.SUMMARY || "summary.json"]: json, stdout: `${json}\n` };
}
