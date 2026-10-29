import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CATEGORIES } from "@/config/categories";
import type { SearchParams } from "@/lib/search/params";
import { SearchUnavailableError, type SearchCard } from "@/lib/search/types";

// The home page module (lot L3b, D21): ISR every 5 minutes, the page's heading (the search is the
// header's pill since the Carte vivante, lot 1), the eleven category tiles, À la Une (8) and the
// 12 newest listings; an engine failure leaves the listing sections out and the page still
// renders. French and Arabic.

const mocks = vi.hoisted(() => ({
  featuredListings: vi.fn<(params: SearchParams, count: number) => Promise<SearchCard[]>>(),
  latestListings: vi.fn<(params: SearchParams, limit: number) => Promise<SearchCard[]>>(),
  warn: vi.fn(),
}));
vi.mock("@/lib/search/service", () => ({ featuredListings: mocks.featuredListings, latestListings: mocks.latestListings }));
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr",
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = { fr: (await import("../../messages/fr.json")).default, ar: (await import("../../messages/ar.json")).default };
  return {
    setRequestLocale: () => undefined,
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar"; namespace?: string }) =>
      createTranslator({ locale, messages: messages[locale] ?? messages.fr, namespace: namespace as never }),
  };
});

const page = await import("@/app/[locale]/(public)/page");
const { default: HomePage } = page;

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

const cards = (prefix: string, count: number, overrides: Partial<SearchCard> = {}) =>
  Array.from({ length: count }, (_, index) => card(`${prefix}${String(index).padStart(3, "0")}`, overrides));

async function renderPage(locale: TestLocale = "fr"): Promise<string> {
  const tree = await HomePage({ params: Promise.resolve({ locale }) });
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  mocks.featuredListings.mockReset();
  mocks.latestListings.mockReset();
  mocks.warn.mockReset();
});

describe("home page", () => {
  it("is ISR for 5 minutes, rendered on the first visit and never at build (no engine there)", () => {
    expect(page.revalidate).toBe(300);
    // An empty list here overrides the locales of the (public) layout: nothing is prerendered.
    expect(page.dynamicParams).toBe(true);
    expect(page.generateStaticParams()).toEqual([]);
  });

  it("renders the heading, the categories, À la Une and the recent listings", async () => {
    mocks.featuredListings.mockResolvedValue(cards("feat", 8, { featured: true }));
    mocks.latestListings.mockResolvedValue(cards("rece", 12));
    const html = await renderPage();
    expect(mocks.featuredListings).toHaveBeenCalledWith({}, 8);
    expect(mocks.latestListings).toHaveBeenCalledWith({}, 12);
    expect(html).toContain(`<h1 class="max-w-2xl text-2xl font-semibold text-balance sm:text-3xl">${fr.Home.title}</h1>`);
    expect(html).toContain(fr.Home.subtitle);
    // One search field per page: the header's pill. The only form left is the car rental module's.
    expect(html).not.toContain('role="search"');
    expect(html.match(/<form[^>]*>/g)).toHaveLength(1);
    expect(html).toContain('data-testid="home-rent-car"');
    expect(html).toContain('data-testid="home-categories"');
    expect(CATEGORIES).toHaveLength(11);
    for (const category of CATEGORIES) expect(html).toContain(`href="/fr/c/${category.id}"`);
    expect(html).toContain(fr.Home.categories.title);
    expect(html).toContain('data-testid="home-featured"');
    expect(html.match(/<article[^>]*data-badge="featured"/g)).toHaveLength(8);
    expect(html).toContain('data-testid="home-recent"');
    expect(html).toContain(fr.Home.recent.title);
    expect(count(html, 'href="/fr/annonce/velo-rece')).toBe(12);
    expect(html).toContain(`href="/fr/recherche">${fr.Home.recent.all}`);
  });

  it("renders in Arabic with Arabic links and labels", async () => {
    mocks.featuredListings.mockResolvedValue(cards("feat", 2, { featured: true }));
    mocks.latestListings.mockResolvedValue(cards("rece", 3));
    const html = await renderPage("ar");
    expect(html).toContain(`>${ar.Home.title}</h1>`);
    expect(html).toContain('action="/ar/recherche"');
    expect(html).toContain(`href="/ar/c/${CATEGORIES[0]?.id}"`);
    expect(html).toContain(ar.Home.categories.title);
    expect(html).toContain(ar.Home.recent.title);
    expect(html).toContain(ar.SearchPage.featured.title);
    expect(html).toContain('href="/ar/annonce/velo-rece000"');
    expect(html).not.toContain(fr.Home.recent.title);
  });

  it("leaves a section out when the engine fails, and still renders the page", async () => {
    mocks.featuredListings.mockRejectedValue(new SearchUnavailableError());
    mocks.latestListings.mockResolvedValue(cards("rece", 2));
    let html = await renderPage();
    expect(html).not.toContain('data-testid="home-featured"');
    expect(html).toContain('data-testid="home-recent"');
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ section: "featured" }), expect.any(String));

    mocks.featuredListings.mockResolvedValue(cards("feat", 1, { featured: true }));
    mocks.latestListings.mockRejectedValue(new Error("engine down"));
    html = await renderPage();
    expect(html).toContain('data-testid="home-featured"');
    expect(html).not.toContain('data-testid="home-recent"');

    mocks.featuredListings.mockRejectedValue(new SearchUnavailableError());
    for (const locale of ["fr", "ar"] as const) {
      html = await renderPage(locale);
      expect(html).toContain('data-testid="home-categories"');
      expect(html).toContain(MESSAGES[locale].Home.title);
      expect(html).not.toContain('data-testid="home-featured"');
      expect(html).not.toContain('data-testid="home-recent"');
    }
  });

  it("hides empty sections (no listing online yet)", async () => {
    mocks.featuredListings.mockResolvedValue([]);
    mocks.latestListings.mockResolvedValue([]);
    const html = await renderPage();
    expect(html).not.toContain('data-testid="home-featured"');
    expect(html).not.toContain('data-testid="home-recent"');
    expect(html).toContain('data-testid="home-categories"');
  });
});
