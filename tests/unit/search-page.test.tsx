import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { resetServerEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import type { SearchParams } from "@/lib/search/params";
import { SearchUnavailableError, type SearchCard, type SearchResponse } from "@/lib/search/types";

// The /recherche page module (lot L3b, D2, D13): metadata (noindex, follow, own canonical) and
// every page state (results, approximate, empty, out of range, unavailable, challenge, rate
// limited), French and Arabic. The engine, the limits and the request-scoped APIs are mocked.

const mocks = vi.hoisted(() => ({
  runSearch: vi.fn<(params: SearchParams) => Promise<SearchResponse>>(),
  enforceSearchLimit: vi.fn<(request: Request) => Promise<{ passGranted: boolean }>>(),
  requestHeaders: { "user-agent": "vitest", "cf-connecting-ip": "203.0.113.7" },
}));
vi.mock("@/lib/search/service", () => ({ runSearch: mocks.runSearch }));
vi.mock("@/lib/search/limits", () => ({ enforceSearchLimit: mocks.enforceSearchLimit }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(mocks.requestHeaders) }));
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
// The map panel's legal foot reopens the consent panel; its provider lives in the root shell.
vi.mock("@/components/consent/consent-link", () => ({ ConsentLink: () => <button type="button">cookies</button> }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = { fr: (await import("../../messages/fr.json")).default, ar: (await import("../../messages/ar.json")).default };
  return {
    setRequestLocale: () => undefined,
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar"; namespace?: string }) =>
      createTranslator({ locale, messages: messages[locale] ?? messages.fr, namespace: namespace as never }),
    getMessages: async ({ locale }: { locale: "fr" | "ar" }) => messages[locale] ?? messages.fr,
  };
});

const { default: SearchPage, generateMetadata } = await import("@/app/[locale]/(public)/recherche/page");
const { loadSearch, pageRequest } = await import("@/app/[locale]/(public)/recherche/search-state");

const MESSAGES = { fr, ar } as const;
type TestLocale = keyof typeof MESSAGES;

function card(id: string, overrides: Partial<SearchCard> = {}): SearchCard {
  return {
    id,
    slugId: `velo-${id}`,
    title: `Vélo ${id}`,
    subcategoryId: "velos",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photo: { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    photoCount: 1,
    sellerType: "individual",
    sortAt: "2026-10-16T10:00:00.000Z",
    bumped: false,
    featured: false,
    ...overrides,
  };
}

function response(params: SearchParams, overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    params,
    sort: params.sort ?? "recent",
    hits: [],
    featured: [],
    total: 0,
    page: params.page ?? 1,
    totalPages: 0,
    approximate: false,
    facets: { categories: {}, subcategories: {} },
    tookMs: 4,
    ...overrides,
  };
}

const props = (query: Record<string, string> = {}, locale: TestLocale = "fr") => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(query),
});

async function renderPage(query: Record<string, string> = {}, locale: TestLocale = "fr"): Promise<string> {
  const tree = await SearchPage(props(query, locale));
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

beforeEach(() => {
  mocks.runSearch.mockReset();
  mocks.enforceSearchLimit.mockReset();
  mocks.enforceSearchLimit.mockResolvedValue({ passGranted: false });
});

describe("search page metadata", () => {
  it("is noindex, follow, with its own canonical and a title naming the search", async () => {
    const meta = await generateMetadata(props({ q: "draisienne", ville: "rabat" }));
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({ canonical: "/fr/recherche" });
    expect(meta.title).toContain("draisienne");
    expect(meta.title).toContain("Rabat");
    const arabic = await generateMetadata(props({}, "ar"));
    expect(arabic.title).toBe(ar.SearchPage.title.all);
    expect(arabic.alternates).toEqual({ canonical: "/ar/recherche" });
    expect(mocks.runSearch).not.toHaveBeenCalled();
  });
});

describe("search page states", () => {
  it("renders the results: bar, count, toolbar, chips, À la Une, grid and pagination", async () => {
    mocks.runSearch.mockImplementation(async (params) =>
      response(params, {
        hits: [card("aaaa2345"), card("bbbb2345", { bumped: true }), card("cccc2345")],
        featured: [card("dddd2345", { featured: true })],
        total: 30,
        totalPages: 2,
        facets: { categories: { vehicules: 30 }, subcategories: { velos: 20, motos: 10 } },
      }),
    );
    const html = await renderPage({ q: "draisienne", ville: "casablanca" });
    expect(mocks.runSearch).toHaveBeenCalledWith(expect.objectContaining({ q: "draisienne", city: "casablanca" }));
    const request = mocks.enforceSearchLimit.mock.calls[0]?.[0];
    expect(new URL(request?.url ?? "").pathname).toBe("/recherche");
    expect(request?.headers.get("cf-connecting-ip")).toBe("203.0.113.7");
    // The header pill is the page's search field (Carte vivante, lot 2): no second search form here.
    expect(html).not.toContain('role="search"');
    expect(html).toMatch(/<h1[^>]*>[^<]*draisienne[^<]*Casablanca<\/h1>/);
    // No basemap configured: the card grid only, no map rows.
    expect(html).not.toContain('data-testid="result-rows"');
    expect(html).toContain('data-ad-slot="search-aside"');
    expect(html).toContain('data-testid="panel-legal"');
    expect(html).toMatch(/data-testid="search-count"[^>]*>30 annonces</);
    expect(html).toContain(`role="toolbar" aria-label="${fr.SearchPage.toolbar}"`);
    expect(html).toContain('data-testid="featured-row"');
    expect(html).toContain('data-testid="results-grid"');
    expect(html).toContain('data-badge="bumped"');
    expect(html).toContain('href="/fr/recherche?q=draisienne&amp;ville=casablanca&amp;page=2"');
    expect(html).not.toContain(fr.SearchPage.approximate.title);
    expect(html).not.toContain(fr.SearchPage.empty.title);
  });

  it("starts on the map rows when a basemap is configured, the grid and its ads waiting for the list view", async () => {
    process.env.MAP_PMTILES_URL = "https://media.joutiya.test/maps/morocco.pmtiles";
    resetServerEnv();
    try {
      mocks.runSearch.mockImplementation(async (params) =>
        response(params, { hits: [card("aaaa2345"), card("bbbb2345")], featured: [card("dddd2345", { featured: true })], total: 3, totalPages: 1 }),
      );
      const html = await renderPage({ q: "draisienne" });
      expect(html).toContain('data-search-view="map"');
      expect(html.match(/data-testid="result-rows"/g)).toHaveLength(2);
      // À la Une first, with its own label (§8), each listing once, linked to its page.
      expect(html.indexOf('data-listing-id="dddd2345"')).toBeLessThan(html.indexOf('data-listing-id="aaaa2345"'));
      expect(html).toContain(`aria-label="${fr.SearchMap.featuredRows}"`);
      expect(html.match(/data-listing-id="aaaa2345"/g)).toHaveLength(1);
      expect(html).toContain('href="/fr/annonce/velo-aaaa2345"');
      expect(html).not.toContain('data-testid="results-grid"');
      expect(html).not.toContain("data-ad-slot");
      expect(html).toContain('data-testid="panel-legal"');
    } finally {
      delete process.env.MAP_PMTILES_URL;
      resetServerEnv();
    }
  });

  it("renders the results in Arabic with Arabic links and labels", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 1, totalPages: 1 }));
    const html = await renderPage({ categorie: "vehicules" }, "ar");
    expect(html).toContain('href="/ar/legal/cgu"');
    expect(html).toContain(ar.SearchMap.legal.short.cgu);
    expect(html).toContain(`aria-label="${ar.SearchPage.toolbar}"`);
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(html).toContain(ar.Categories.vehicules.name);
    expect(html).toContain('href="/ar/annonce/velo-aaaa2345"');
    expect(html).not.toContain(fr.SearchPage.toolbar);
  });

  it("caps the count at the reachable results", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 5000, totalPages: 50 }));
    const html = await renderPage({});
    expect(text(html)).toMatch(/Plus de 1\s200 annonces/);
  });

  it("says when the results only match some of the words", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 1, totalPages: 1, approximate: true }));
    for (const locale of ["fr", "ar"] as const) {
      const html = await renderPage({ q: "draisienne rouge" }, locale);
      expect(html).toContain(MESSAGES[locale].SearchPage.approximate.title);
      expect(html).toContain('data-testid="results-grid"');
    }
  });

  it("shows the empty state with ways out, and still the paid slots", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { featured: [card("dddd2345", { featured: true })] }));
    for (const locale of ["fr", "ar"] as const) {
      const html = await renderPage({ q: "draisienne", ville: "rabat" }, locale);
      const t = MESSAGES[locale].SearchPage.empty;
      expect(html).toContain(t.title);
      expect(html).toContain(t.widenCountry);
      expect(html).not.toContain('data-testid="results-grid"');
      expect(html).toContain('data-testid="featured-row"');
      expect(html).toMatch(/data-testid="search-count"[^>]*>[^<]+</);
    }
  });

  it("reads a sentence as filters it shows as removable chips, unless the search asks for the exact text", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 1, totalPages: 1 }));
    const html = await renderPage({ q: "velo pas cher moins de 3000 dh", ville: "casablanca" });
    expect(mocks.runSearch).toHaveBeenCalledWith(
      expect.objectContaining({ category: "vehicules", subcategory: "velos", priceMax: 3000, sort: "price_asc", city: "casablanca" }),
    );
    expect(mocks.runSearch.mock.calls[0]?.[0].q).toBeUndefined();
    expect(html).toContain('data-testid="understood"');
    expect(html).toMatch(/<h1[^>]*>[^<]*Vélos[^<]*Casablanca<\/h1>/);
    // Each chip removes its own item and keeps the sentence searched as typed from then on.
    expect(html).toContain(`aria-label="${fr.SearchInterpret.remove.replace("{filter}", "Vélos")}"`);
    expect(html).toMatch(/href="\/fr\/recherche\?q=velo[^"]*brut=1[^"]*"/);
    expect(html).toContain('data-testid="search-exact"');
    expect((await generateMetadata(props({ q: "velo", ville: "rabat" }))).title).toContain("Vélos");

    // « à côté » with a zone: one chip for it, « À 3 km de vous », and no second zone chip in the toolbar.
    const near = await renderPage({ q: "velo a cote", zone: "33.599,-7.62,3" });
    expect(near).toContain(`aria-label="${fr.SearchInterpret.remove.replace("{filter}", fr.SearchInterpret.nearZone.replace("{km}", "3"))}"`);
    expect(near).not.toContain('data-filter="location"');
    expect(await renderPage({ q: "draisienne", zone: "33.599,-7.62,3" })).toContain('data-filter="location"');

    mocks.runSearch.mockClear();
    const exact = await renderPage({ q: "velo pas cher", brut: "1" });
    expect(mocks.runSearch).toHaveBeenCalledWith(expect.objectContaining({ q: "velo pas cher", raw: true }));
    expect(mocks.runSearch.mock.calls[0]?.[0].subcategory).toBeUndefined();
    expect(exact).not.toContain('data-testid="understood"');
  });

  it("sends a page past the end back to the first page", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { total: 30, totalPages: 2 }));
    const html = await renderPage({ q: "draisienne", page: "7" });
    expect(text(html)).toContain(fr.SearchPage.empty.outOfRangeTitle);
    expect(html).toContain('href="/fr/recherche?q=draisienne"');
  });

  it("shows an honest error with retry when the engine is down, keeping the criteria", async () => {
    for (const failure of [new SearchUnavailableError(), new Error("boom")]) {
      mocks.runSearch.mockRejectedValue(failure);
      for (const locale of ["fr", "ar"] as const) {
        const html = await renderPage({ q: "draisienne" }, locale);
        const t = MESSAGES[locale].SearchPage.error;
        expect(html).toContain('role="alert"');
        expect(html).toContain(t.title);
        expect(html).toContain(t.retry);
        // The criteria stay in the title (and in the header pill, bound by the page once hydrated).
        expect(html).toMatch(/<h1[^>]*>[^<]*draisienne[^<]*<\/h1>/);
        expect(html).not.toContain('data-testid="search-count"');
        expect(html).not.toContain('role="toolbar"');
      }
    }
  });

  it("asks for the Turnstile challenge over the limits without a pass, without searching", async () => {
    for (const code of ["turnstile_required", "turnstile_failed"] as const) {
      mocks.enforceSearchLimit.mockRejectedValue(new HttpError(403, code));
      for (const locale of ["fr", "ar"] as const) {
        const html = await renderPage({ q: "draisienne" }, locale);
        expect(html).toContain(MESSAGES[locale].SearchPage.challenge.title);
        expect(html).not.toContain('data-testid="results-grid"');
      }
    }
    expect(mocks.runSearch).not.toHaveBeenCalled();
  });

  it("asks to wait when rate limited with a pass", async () => {
    mocks.enforceSearchLimit.mockRejectedValue(new HttpError(429, "rate_limited", undefined, { headers: { "Retry-After": "30" } }));
    for (const locale of ["fr", "ar"] as const) {
      const html = await renderPage({ q: "draisienne" }, locale);
      expect(html).toContain(MESSAGES[locale].SearchPage.rateLimited.title);
      expect(html).toContain('role="alert"');
    }
    expect(mocks.runSearch).not.toHaveBeenCalled();
  });
});

describe("loadSearch", () => {
  const request = new Request("https://joutiya.ma/recherche");

  it("maps the limit and engine failures to page states", async () => {
    mocks.enforceSearchLimit.mockRejectedValueOnce(new HttpError(429, "rate_limited", undefined, { headers: { "Retry-After": "12" } }));
    expect(await loadSearch({}, request)).toEqual({ kind: "rate_limited", retryAfter: 12 });
    mocks.enforceSearchLimit.mockRejectedValueOnce(new HttpError(429, "rate_limited"));
    expect(await loadSearch({}, request)).toEqual({ kind: "rate_limited", retryAfter: undefined });
    mocks.enforceSearchLimit.mockRejectedValueOnce(new HttpError(403, "turnstile_required"));
    expect(await loadSearch({}, request)).toEqual({ kind: "challenge" });
    mocks.enforceSearchLimit.mockRejectedValueOnce(new Error("valkey down"));
    expect(await loadSearch({}, request)).toEqual({ kind: "unavailable" });
    mocks.runSearch.mockRejectedValueOnce(new SearchUnavailableError());
    expect(await loadSearch({}, request)).toEqual({ kind: "unavailable" });
    const ok = response({ q: "draisienne" });
    mocks.runSearch.mockResolvedValueOnce(ok);
    expect(await loadSearch({ q: "draisienne" }, request)).toEqual({ kind: "results", response: ok });
  });

  it("builds the page request from the incoming headers", async () => {
    const built = await pageRequest();
    expect(new URL(built.url).pathname).toBe("/recherche");
    expect(built.headers.get("user-agent")).toBe("vitest");
  });
});
