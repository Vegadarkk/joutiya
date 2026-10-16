import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http/errors";
import { SearchUnavailableError, type SearchResponse } from "@/lib/search/types";

// GET /api/search wiring (design D2, D13): canonical parameters to the service, limits before the
// engine, 503 search_unavailable, no-store, the device cookie and the pass cookie once solved.

const mocks = vi.hoisted(() => ({
  runSearch: vi.fn(),
  enforceSearchLimit: vi.fn(async () => ({ passGranted: false })),
  capture: vi.fn(),
}));

vi.mock("@/lib/search/service", () => ({ runSearch: mocks.runSearch }));
vi.mock("@/lib/search/limits", () => ({ enforceSearchLimit: mocks.enforceSearchLimit }));
vi.mock("@/lib/observability/capture", () => ({ captureServerException: mocks.capture }));

import { GET } from "@/app/api/search/route";
import { newDeviceCookie } from "@/lib/security/device";

function response(params: SearchResponse["params"]): SearchResponse {
  return { params, sort: "recent", hits: [], featured: [], total: 0, page: 1, totalPages: 0, approximate: false, facets: { categories: {}, subcategories: {} }, tookMs: 1 };
}

async function get(query: string, cookie?: string) {
  const request = new NextRequest(`http://localhost:3000/api/search${query}`, { headers: { "x-forwarded-for": "10.88.0.1", ...(cookie ? { cookie } : {}) } });
  const res = await GET(request, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

beforeEach(() => {
  mocks.runSearch.mockReset();
  mocks.runSearch.mockImplementation(async (params: SearchResponse["params"]) => response(params));
  mocks.enforceSearchLimit.mockReset();
  mocks.enforceSearchLimit.mockResolvedValue({ passGranted: false });
});

describe("GET /api/search", () => {
  it("searches with the canonical parameters and never caches", async () => {
    const res = await get("?q=+velo++rouge+&sous-categorie=velos&ville=casablanca&rayon=7&quartier=Maarif&tri=recentes&inconnu=1");
    expect(res.status).toBe(200);
    expect(mocks.runSearch).toHaveBeenCalledWith({ q: "velo rouge", category: "vehicules", subcategory: "velos", city: "casablanca", region: "06", district: "maarif", sort: "recent" });
    expect(res.body.params).toMatchObject({ q: "velo rouge", subcategory: "velos" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("checks the limits before the engine", async () => {
    mocks.enforceSearchLimit.mockRejectedValueOnce(new HttpError(403, "turnstile_required"));
    const res = await get("?q=velo");
    expect([res.status, (res.body.error as { code: string }).code]).toEqual([403, "turnstile_required"]);
    expect(mocks.runSearch).not.toHaveBeenCalled();
  });

  it("answers 503 search_unavailable when the engine is down", async () => {
    mocks.runSearch.mockRejectedValueOnce(new SearchUnavailableError());
    const res = await get("");
    expect([res.status, (res.body.error as { code: string }).code]).toEqual([503, "search_unavailable"]);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 500 for any other failure", async () => {
    mocks.runSearch.mockRejectedValueOnce(new Error("bug"));
    expect((await get("")).status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("sets the device cookie when missing and the pass cookie once the challenge is solved", async () => {
    mocks.enforceSearchLimit.mockResolvedValueOnce({ passGranted: true });
    const fresh = await get("");
    const cookies = fresh.headers.getSetCookie();
    const did = cookies.find((line) => line.startsWith("__Host-did="));
    const tsv = cookies.find((line) => line.startsWith("__Host-tsv="));
    expect(did).toBeDefined();
    expect(tsv).toMatch(/Max-Age=1800/);

    const device = newDeviceCookie();
    mocks.enforceSearchLimit.mockResolvedValueOnce({ passGranted: true });
    const known = await get("", `__Host-did=${device.value}`);
    const lines = known.headers.getSetCookie();
    expect(lines.some((line) => line.startsWith("__Host-did="))).toBe(false);
    expect(lines.some((line) => line.startsWith("__Host-tsv="))).toBe(true);

    const plain = await get("", `__Host-did=${device.value}`);
    expect(plain.headers.getSetCookie()).toEqual([]);
  });
});
