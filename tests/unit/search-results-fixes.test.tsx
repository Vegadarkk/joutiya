import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { loadMessages } from "@/i18n/messages";
import type { SearchParams } from "@/lib/search/params";
import type { SearchCard, SearchResponse } from "@/lib/search/types";

// /recherche review fixes: the results toolbar fits a 360 px phone (icon-only save, shrinking sort,
// tighter filters button), Tarifit counts read "1 200" like the French pages, and a listing shown
// in the À la Une band is not repeated in the grid below it.

const mocks = vi.hoisted(() => ({
  runSearch: vi.fn<(params: SearchParams) => Promise<SearchResponse>>(),
  enforceSearchLimit: vi.fn<(request: Request) => Promise<{ passGranted: boolean }>>(),
}));
vi.mock("@/lib/search/service", () => ({ runSearch: mocks.runSearch }));
vi.mock("@/lib/search/limits", () => ({ enforceSearchLimit: mocks.enforceSearchLimit }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest", "cf-connecting-ip": "203.0.113.7" }) }));
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));
// Like next-intl's request config: the locale's messages over French, formatted with that locale.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { loadMessages: load } = await import("@/i18n/messages");
  return {
    setRequestLocale: () => undefined,
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar" | "rif"; namespace?: string }) =>
      createTranslator({ locale, messages: await load(locale), namespace: namespace as never }),
  };
});

const { default: SearchPage } = await import("@/app/[locale]/(public)/recherche/page");

const MESSAGES = { fr, ar, rif: await loadMessages("rif") } as const;
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

async function renderPage(query: Record<string, string>, locale: TestLocale = "fr"): Promise<string> {
  const tree = await SearchPage({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

/** The markup between the toolbar's opening tag and the pending bar after it. */
function toolbar(html: string): string {
  const start = html.indexOf('role="toolbar"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('aria-hidden="true" class="h-0.5', start));
}

const count = (html: string) => /data-testid="search-count"[^>]*>([^<]*)</.exec(html)?.[1];

beforeEach(() => {
  mocks.runSearch.mockReset();
  mocks.enforceSearchLimit.mockReset();
  mocks.enforceSearchLimit.mockResolvedValue({ passGranted: false });
});

describe("results toolbar on a phone", () => {
  it("keeps only shrinkable or 44 px items next to the filters button, in French and Arabic", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 1, totalPages: 1 }));
    for (const locale of ["fr", "ar"] as const) {
      const bar = toolbar(await renderPage({ q: "velo", ville: "rabat", "prix-max": "2000", vendeur: "pro" }, locale));
      // Filtres: tighter padding and gaps below sm (its count badge stays).
      expect(bar).toMatch(/<button[^>]*class="[^"]*max-sm:px-3[^"]*"[^>]*aria-label="[^"]+"/);
      // Save: a 44 px icon button below md whose label stays its accessible name.
      expect(bar).toMatch(/data-testid="save-search-button"/);
      expect(bar).toMatch(/<button[^>]*class="[^"]*max-md:w-11[^"]*max-md:px-0[^"]*"[^>]*data-testid="save-search-button"/);
      expect(bar).toContain(`<span class="max-md:sr-only">${MESSAGES[locale].SavedSearches.button.save}</span>`);
      // Sort: the whole chain can shrink and the select truncates; its label is for screen readers on phones.
      expect(bar).toMatch(/<div class="flex min-w-0 items-center gap-2 \*:min-w-0">/);
      expect(bar).toMatch(/<label[^>]*class="[^"]*max-sm:sr-only"/);
      expect(bar).toMatch(/<select[^>]*class="[^"]*max-w-full min-w-0 truncate[^"]*"/);
    }
  });
});

describe("result count", () => {
  it("groups thousands the French way on Tarifit pages (no Intl data for rif)", async () => {
    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 5000, totalPages: 50 }));
    expect(count(await renderPage({}, "rif"))).toBe("Plus de 1 200 annonces");
    expect(count(await renderPage({}, "fr"))).toBe("Plus de 1 200 annonces");

    mocks.runSearch.mockImplementation(async (params) => response(params, { hits: [card("aaaa2345")], total: 1150, totalPages: 48 }));
    expect(count(await renderPage({ q: "velo" }, "rif"))).toBe("1 150 annonces");
  });
});

describe("À la Une band and results grid", () => {
  it("shows a featured listing in the band only, never twice", async () => {
    mocks.runSearch.mockImplementation(async (params) =>
      response(params, {
        hits: [card("aaaa2345"), card("bbbb2345"), card("cccc2345")],
        featured: [card("bbbb2345", { featured: true }), card("dddd2345", { featured: true })],
        total: 3,
        totalPages: 1,
      }),
    );
    const html = await renderPage({ q: "velo" });
    const band = html.slice(html.indexOf('data-testid="featured-row"'), html.indexOf('data-testid="results-grid"'));
    const grid = html.slice(html.indexOf('data-testid="results-grid"'));
    expect(band).toContain('href="/fr/annonce/velo-bbbb2345"');
    expect(band).toContain('href="/fr/annonce/velo-dddd2345"');
    expect(grid).toContain('href="/fr/annonce/velo-aaaa2345"');
    expect(grid).toContain('href="/fr/annonce/velo-cccc2345"');
    expect(grid).not.toContain("velo-bbbb2345");
    expect(count(html)).toBe("3 annonces");
  });

  it("drops the empty grid when every result sits in the band", async () => {
    mocks.runSearch.mockImplementation(async (params) =>
      response(params, { hits: [card("aaaa2345")], featured: [card("aaaa2345", { featured: true })], total: 1, totalPages: 1 }),
    );
    const html = await renderPage({ q: "velo" });
    expect(html).toContain('data-testid="featured-row"');
    expect(html).not.toContain('data-testid="results-grid"');
    expect(html).not.toContain(fr.SearchPage.empty.title);
  });
});
