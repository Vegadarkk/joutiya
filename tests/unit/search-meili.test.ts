import { describe, expect, it } from "vitest";
import { MeiliEngine, MeiliError } from "@/lib/search/meili";
import { SEARCH_SETTINGS } from "@/lib/search/settings";
import { CARD_FIELDS, SearchUnavailableError } from "@/lib/search/types";
import { DOCS } from "../search/fixtures";

// The Meilisearch adapter against a scripted fetch: request shapes (verified on a 1.55.0 container,
// see tests/search for the live contract) and the error mapping.

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  signal: boolean;
}
type Route = (call: Call) => { status?: number; body?: unknown } | Error;

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal instanceof AbortSignal,
    };
    calls.push(call);
    const result = route(call);
    if (result instanceof Error) throw result;
    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), { status: result.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const engineWith = (route: Route, keys: { searchKey?: string; indexKey?: string } = { searchKey: "search-key", indexKey: "index-key" }) => {
  const { fetcher, calls } = fakeFetch(route);
  return { engine: new MeiliEngine({ url: "http://meili:7700/", ...keys, fetch: fetcher }), calls };
};

const task = (uid: number, status = "succeeded", error: unknown = null) => ({ uid, status, type: "documentAdditionOrUpdate", error });

/** Index present with up-to-date settings; every write task succeeds. */
const readyIndex: Route = (call) => {
  if (call.method === "GET" && call.path === "/indexes/listings_v1") return { body: { uid: "listings_v1", primaryKey: "id" } };
  if (call.method === "GET" && call.path === "/indexes/listings_v1/settings") return { body: { ...SEARCH_SETTINGS, embedders: {} } };
  if (call.method === "GET" && call.path.startsWith("/tasks/")) return { body: task(Number(call.path.slice(7))) };
  if (call.method === "POST" || call.method === "PATCH" || call.method === "DELETE") return { status: 202, body: { taskUid: 41, status: "enqueued" } };
  return { status: 404, body: { code: "not_found" } };
};

describe("MeiliEngine.search", () => {
  it("sends one multi-search with the search key and maps the results", async () => {
    const { engine, calls } = engineWith(() => ({
      body: {
        results: [
          { indexUid: "listings_v1", hits: [{ id: "v1" }], query: "golf", processingTimeMs: 3, hitsPerPage: 24, page: 2, totalPages: 209, totalHits: 5000, facetDistribution: { citySlug: { rabat: 4 } } },
          { indexUid: "listings_v1", hits: [], query: "", processingTimeMs: 1, hitsPerPage: 0, page: 1, totalPages: 0, totalHits: 7 },
        ],
      },
    }));
    const results = await engine.search([
      {
        q: "golf",
        page: 2,
        hitsPerPage: 24,
        filter: { and: [{ field: "citySlug", op: "eq", value: "rabat" }, { field: "price", op: "lte", value: 9000 }] },
        sort: [{ field: "price", dir: "asc" }, { geoPoint: { lat: 34.02, lng: -6.84 }, dir: "asc" }],
        facets: ["citySlug"],
      },
      { q: "", page: 1, hitsPerPage: 0, matchingStrategy: "last", fields: ["id"] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/multi-search", auth: "Bearer search-key", signal: true });
    expect(calls[0]?.body).toEqual({
      queries: [
        {
          indexUid: "listings_v1",
          q: "golf",
          filter: '(citySlug = "rabat") AND (price <= 9000)',
          sort: ["price:asc", "_geoPoint(34.02,-6.84):asc"],
          page: 2,
          hitsPerPage: 24,
          facets: ["citySlug"],
          matchingStrategy: "all",
          attributesToRetrieve: [...CARD_FIELDS],
        },
        { indexUid: "listings_v1", q: "", page: 1, hitsPerPage: 0, matchingStrategy: "last", attributesToRetrieve: ["id"] },
      ],
    });
    // Exhaustive total, pages limited to maxTotalHits (1200 / 24 = 50).
    expect(results[0]).toEqual({ hits: [{ id: "v1" }], totalHits: 5000, totalPages: 50, page: 2, facetDistribution: { citySlug: { rabat: 4 } }, processingTimeMs: 3 });
    expect(results[1]).toMatchObject({ totalHits: 7, totalPages: 0 });
  });

  it("does nothing for no query", async () => {
    const { engine, calls } = engineWith(() => ({ body: {} }));
    expect(await engine.search([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("maps unavailability to SearchUnavailableError and bad requests to MeiliError", async () => {
    const cases: [Route, unknown][] = [
      [() => new TypeError("fetch failed"), SearchUnavailableError],
      [() => ({ status: 503, body: { code: "too_many_search_requests" } }), SearchUnavailableError],
      [() => ({ status: 502 }), SearchUnavailableError],
      [() => ({ status: 404, body: { code: "index_not_found", message: "Index `listings_v1` not found." } }), SearchUnavailableError],
      [() => ({ status: 403, body: { code: "invalid_api_key" } }), SearchUnavailableError],
      [() => ({ body: { unexpected: true } }), SearchUnavailableError],
      [() => ({ status: 400, body: { code: "invalid_search_filter", message: "bad filter" } }), MeiliError],
    ];
    for (const [route, error] of cases) {
      const { engine } = engineWith(route);
      await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1 }])).rejects.toBeInstanceOf(error);
    }
    const { engine, calls } = engineWith(() => ({ body: {} }), { indexKey: "index-key" });
    await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1 }])).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(calls).toEqual([]);
  });

  it("validates queries before any request", async () => {
    const { engine, calls } = engineWith(() => ({ body: {} }));
    await expect(engine.search([{ q: "", page: 0, hitsPerPage: 1 }])).rejects.toThrow(RangeError);
    await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1, facets: ["title"] }])).rejects.toThrow(/facetable/);
    await expect(engine.search([{ q: "", page: 1, hitsPerPage: 1, filter: { field: "ownerUid", op: "eq", value: "x" } }])).rejects.toThrow(/filterable/);
    expect(calls).toEqual([]);
  });
});

describe("MeiliEngine writes", () => {
  it("checks the index once, then adds documents with the index key and waits for the task", async () => {
    const { engine, calls } = engineWith(readyIndex);
    await engine.upsert(DOCS.slice(0, 2));
    await engine.remove(["v1"]);
    await engine.upsert([]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /indexes/listings_v1",
      "GET /indexes/listings_v1/settings",
      "POST /indexes/listings_v1/documents?primaryKey=id",
      "GET /tasks/41",
      "POST /indexes/listings_v1/documents/delete-batch",
      "GET /tasks/41",
    ]);
    expect(calls.every((call) => call.auth === "Bearer index-key")).toBe(true);
    expect((calls[2]?.body as { id: string }[]).map((doc) => doc.id)).toEqual(["v1", "v2"]);
    expect(calls[4]?.body).toEqual(["v1"]);
  });

  it("creates a missing index and patches only the settings that differ", async () => {
    const { engine, calls } = engineWith((call) => {
      if (call.method === "GET" && call.path === "/indexes/listings_v1") return { status: 404, body: { code: "index_not_found" } };
      if (call.method === "GET" && call.path === "/indexes/listings_v1/settings") return { body: { ...SEARCH_SETTINGS, pagination: { maxTotalHits: 1000 }, stopWords: [] } };
      return readyIndex(call);
    });
    expect(await engine.ensureReady()).toEqual({ created: true, settingsUpdated: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /indexes/listings_v1",
      "POST /indexes",
      "GET /tasks/41",
      "GET /indexes/listings_v1/settings",
      "PATCH /indexes/listings_v1/settings",
      "GET /tasks/41",
    ]);
    expect(calls[1]?.body).toEqual({ uid: "listings_v1", primaryKey: "id" });
    expect(calls[4]?.body).toEqual({ stopWords: SEARCH_SETTINGS.stopWords, pagination: SEARCH_SETTINGS.pagination });
  });

  it("raises a failed task as MeiliError and retries the index check after a failure", async () => {
    let fail = true;
    const { engine } = engineWith((call) => {
      if (call.method === "GET" && call.path.startsWith("/tasks/")) return { body: fail ? task(41, "failed", { message: "invalid geo", code: "invalid_document_geo_field" }) : task(41) };
      return readyIndex(call);
    });
    await expect(engine.upsert(DOCS.slice(0, 1))).rejects.toMatchObject({ name: "MeiliError", code: "invalid_document_geo_field" });
    fail = false;
    await expect(engine.upsert(DOCS.slice(0, 1))).resolves.toBeUndefined();
  });

  it("needs the index key", async () => {
    const { engine, calls } = engineWith(readyIndex, { searchKey: "search-key" });
    await expect(engine.upsert(DOCS.slice(0, 1))).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(calls).toEqual([]);
  });

  it("swaps indexes, waiting through a later task when the key cannot read the swap task", async () => {
    const { engine, calls } = engineWith((call) => {
      if (call.path === "/tasks/7") return { status: 404, body: { code: "task_not_found" } };
      if (call.path === "/swap-indexes") return { status: 202, body: { taskUid: 7 } };
      return readyIndex(call);
    });
    await engine.swapWith("listings_v2");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /swap-indexes", "GET /tasks/7", "POST /indexes/listings_v1/documents/delete-batch", "GET /tasks/41"]);
    expect(calls[0]?.body).toEqual([{ indexes: ["listings_v1", "listings_v2"] }]);
  });
});

describe("MeiliEngine reads", () => {
  it("pages documents through the documents fetch API", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, version: i }));
    const { engine, calls } = engineWith((call) => {
      const { offset, limit } = call.body as { offset: number; limit: number };
      return { body: { results: all.slice(offset, offset + limit), offset, limit, total: all.length } };
    });
    const pages: unknown[][] = [];
    for await (const page of engine.documents({ filter: { field: "sitemapShard", op: "eq", value: 3 }, fields: ["id", "version"], pageSize: 2 })) pages.push(page);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/indexes/listings_v1/documents/fetch", auth: "Bearer search-key", body: { filter: "sitemapShard = 3", fields: ["id", "version"], offset: 0, limit: 2 } });
    expect(calls.map((call) => (call.body as { offset: number }).offset)).toEqual([0, 2, 4]);
    const versions: { id: string; version: number }[] = [];
    for await (const page of engine.versions()) versions.push(...page);
    expect(versions).toEqual(all);
    const capped: unknown[] = [];
    for await (const page of engine.documents({ fields: ["id"], pageSize: 2, max: 3 })) capped.push(...page);
    expect(capped).toHaveLength(3);
  });

  it("reads documents with the index key when no search key is set (worker)", async () => {
    const { engine, calls } = engineWith(() => ({ body: { results: [], offset: 0, limit: 1000, total: 0 } }), { indexKey: "index-key" });
    for await (const _page of engine.versions()) void _page;
    expect(calls[0]?.auth).toBe("Bearer index-key");
  });

  it("reports health without throwing", async () => {
    const healthy = engineWith((call) => (call.path === "/health" ? { body: { status: "available" } } : { body: { results: [], total: 0 } }));
    expect(await healthy.engine.healthy()).toBe(true);
    expect(healthy.calls[0]?.auth).toBeNull();
    const missing = engineWith((call) => (call.path === "/health" ? { body: { status: "available" } } : { status: 404, body: { code: "index_not_found" } }));
    expect(await missing.engine.healthy()).toBe(false);
    const down = engineWith(() => new TypeError("connect ECONNREFUSED"));
    expect(await down.engine.healthy()).toBe(false);
  });

  it("refuses an invalid index uid", () => {
    expect(() => new MeiliEngine({ url: "http://meili:7700", index: "../keys" })).toThrow(RangeError);
  });
});
