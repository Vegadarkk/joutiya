import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CATEGORIES } from "@/config/categories";
import type * as ClientMessages from "@/i18n/client-messages";
import { resetServerEnv } from "@/lib/env";
import type { SearchParams } from "@/lib/search/params";
import { SearchUnavailableError, type SearchCard } from "@/lib/search/types";

// The home page module (lot L3b, D21; Carte vivante, lot 3): ISR every 5 minutes, the page's
// heading (the search is the header's pill since lot 1). Without a basemap, the classic list page:
// the thirteen category tiles, À la Une (8) and the 12 newest listings. With one, the living map's
// panel: the categories rail, À la Une and the newest listings as rows (pins on the map once
// hydrated), the car rental entry, the pillars and the legal links. An engine failure leaves the
// listing sections out and the page still renders. French and Arabic.

const mocks = vi.hoisted(() => ({
  featuredListings: vi.fn<(params: SearchParams, count: number) => Promise<SearchCard[]>>(),
  latestListings: vi.fn<(params: SearchParams, limit: number) => Promise<SearchCard[]>>(),
  warn: vi.fn(),
}));
vi.mock("@/lib/search/service", () => ({ featuredListings: mocks.featuredListings, latestListings: mocks.latestListings }));
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
// The map panel's legal foot reopens the consent panel; its provider lives in the root shell.
vi.mock("@/components/consent/consent-link", () => ({ ConsentLink: () => <button type="button">cookies</button> }));
// In production the server components translate from the request's whole catalog; rendered here in
// one React tree, they read the page's nested client provider: give it every namespace.
vi.mock("@/i18n/client-messages", async (importOriginal) => ({
  ...(await importOriginal<typeof ClientMessages>()),
  pickMessages: (messages: AbstractIntlMessages) => messages,
}));
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
    getMessages: async ({ locale }: { locale: "fr" | "ar" }) => messages[locale] ?? messages.fr,
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

/** Renders with a basemap configured: the living map's panel. */
async function withMap<T>(run: () => Promise<T>): Promise<T> {
  process.env.MAP_PMTILES_URL = "https://media.joutiya.test/maps/morocco.pmtiles";
  resetServerEnv();
  try {
    return await run();
  } finally {
    delete process.env.MAP_PMTILES_URL;
    resetServerEnv();
  }
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
const heading = (title: string) => `<h1 id="home-title" class="max-w-2xl text-2xl font-semibold text-balance sm:text-3xl">${title}</h1>`;

beforeEach(() => {
  mocks.featuredListings.mockReset();
  mocks.latestListings.mockReset();
  mocks.warn.mockReset();
});

describe("home page", () => {
  it("is ISR for 5 minutes, rendered on the first visit and never at build (no engine there)", () => {
    expect(page.revalidate).toBe(300);
    // No locale here nor in the (public) layout: nothing is prerendered (scripts/check-prerender.ts).
    expect(page.dynamicParams).toBe(true);
    expect(page.generateStaticParams()).toEqual([]);
  });

  it("without a basemap: the list page with the heading, the categories, À la Une and the 12 newest", async () => {
    mocks.featuredListings.mockResolvedValue(cards("feat", 8, { featured: true }));
    mocks.latestListings.mockResolvedValue(cards("rece", 24));
    const html = await renderPage();
    expect(mocks.featuredListings).toHaveBeenCalledWith({}, 8);
    // One engine call serves the map's pins (24) and the list's grid (the first 12).
    expect(mocks.latestListings).toHaveBeenCalledWith({}, 24);
    expect(html).toContain('data-search-view="list"');
    expect(html).toContain('data-search-variant="home"');
    expect(html).toContain(heading(fr.Home.title));
    expect(html).toContain(fr.Home.subtitle);
    // One search field per page: the header's pill. The only form left is the car rental module's.
    expect(html).not.toContain('role="search"');
    expect(html.match(/<form[^>]*>/g)).toHaveLength(1);
    expect(html).toContain('data-testid="home-rent-car"');
    expect(html).toContain('data-testid="home-categories"');
    expect(CATEGORIES).toHaveLength(15);
    for (const category of CATEGORIES) expect(html).toContain(`href="/fr/c/${category.id}"`);
    expect(html).toContain(fr.Home.categories.title);
    expect(html).toContain('data-testid="home-featured"');
    expect(html.match(/<article[^>]*data-badge="featured"/g)).toHaveLength(8);
    expect(html).toContain('data-testid="home-recent"');
    expect(html).toContain(fr.Home.recent.title);
    expect(count(html, 'href="/fr/annonce/velo-rece')).toBe(12);
    expect(html).toContain(`href="/fr/recherche">${fr.Home.recent.all}`);
    expect(html).toContain('data-testid="home-pillars"');
    // Nothing of the map's panel: no rows, no rail, no switch (it needs a basemap).
    expect(html).not.toContain('data-testid="home-category-rail"');
    expect(html).not.toContain('data-testid="result-rows"');
    expect(html).not.toContain('data-testid="view-toggle"');
  });

  it("with a basemap: the map's panel first, the list sections and the ad waiting for the list view", async () => {
    // "rece001" is also drawn for À la Une: it shows once, as an À la Une row.
    mocks.featuredListings.mockResolvedValue([card("feat000", { featured: true }), card("rece001", { featured: true })]);
    mocks.latestListings.mockResolvedValue(cards("rece", 24));
    const html = await withMap(() => renderPage());
    expect(html).toContain('data-search-view="map"');
    expect(html).toContain('data-search-variant="home"');
    // Phones open the sheet half way (the CSS reads it before hydration).
    expect(html).toContain('data-search-start="half"');
    expect(html).toContain(heading(fr.Home.title));
    expect(html).toContain(fr.Home.subtitle);
    // The thirteen categories as a rail of arches (the header's chip row is left out on this page).
    expect(html).toContain('data-testid="home-category-rail"');
    for (const category of CATEGORIES) expect(count(html, `href="/fr/c/${category.id}"`)).toBe(1);
    // À la Une first, with its §8 heading, then the newest listings.
    expect(html.match(/data-testid="result-rows"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="home-featured-rows"');
    expect(html).toContain(fr.SearchPage.featured.sponsored);
    expect(html).toContain(`aria-label="${fr.SearchMap.featuredRows}"`);
    expect(html.indexOf('data-listing-id="feat000"')).toBeLessThan(html.indexOf('data-listing-id="rece000"'));
    expect(count(html, 'data-listing-id="rece001"')).toBe(1);
    expect(count(html, 'data-map-row=""')).toBe(25);
    expect(html).toContain('href="/fr/annonce/velo-rece023"');
    expect(html).toContain(`href="/fr/recherche">${fr.Home.recent.all}`);
    // The car rental search, the pillars and the legal links.
    expect(html).toContain('data-testid="home-rent-car-link"');
    expect(html).toContain('href="/fr/recherche?categorie=vehicules&amp;sous-categorie=location-voitures"');
    expect(html).toContain(fr.Rental.home.open);
    expect(html).toContain('data-testid="home-pillars-compact"');
    expect(html).toContain('data-testid="panel-legal"');
    // No list section, no ad, no form: the header's pill is the only search field.
    expect(html).not.toContain('data-testid="home-categories"');
    expect(html).not.toContain('data-testid="home-featured"');
    expect(html).not.toContain('data-testid="home-recent"');
    expect(html).not.toContain("data-ad-slot");
    expect(html).not.toMatch(/<form[^>]*>/);
  });

  it("renders in Arabic with Arabic links and labels, in both views", async () => {
    mocks.featuredListings.mockResolvedValue(cards("feat", 2, { featured: true }));
    mocks.latestListings.mockResolvedValue(cards("rece", 3));
    let html = await renderPage("ar");
    expect(html).toContain(`>${ar.Home.title}</h1>`);
    expect(html).toContain('action="/ar/recherche"');
    expect(html).toContain(`href="/ar/c/${CATEGORIES[0]?.id}"`);
    expect(html).toContain(ar.Home.categories.title);
    expect(html).toContain(ar.Home.recent.title);
    expect(html).toContain(ar.SearchPage.featured.title);
    expect(html).toContain('href="/ar/annonce/velo-rece000"');
    expect(html).not.toContain(fr.Home.recent.title);

    html = await withMap(() => renderPage("ar"));
    expect(html).toContain(`>${ar.Home.title}</h1>`);
    expect(html).toContain(ar.Home.categories.title);
    expect(html).toContain(ar.SearchPage.featured.title);
    expect(html).toContain(ar.Rental.home.open);
    expect(html).toContain('href="/ar/annonce/velo-rece002"');
    expect(html).toContain('href="/ar/legal/cgu"');
    expect(html).not.toContain(fr.Home.recent.title);
  });

  it("leaves a section out when the engine fails, and still renders the page", async () => {
    mocks.featuredListings.mockRejectedValue(new SearchUnavailableError());
    mocks.latestListings.mockResolvedValue(cards("rece", 2));
    let html = await renderPage();
    expect(html).not.toContain('data-testid="home-featured"');
    expect(html).toContain('data-testid="home-recent"');
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ section: "featured" }), expect.any(String));
    html = await withMap(() => renderPage());
    expect(html).not.toContain('data-testid="home-featured-rows"');
    expect(html).toContain('data-testid="home-recent-rows"');

    mocks.featuredListings.mockResolvedValue(cards("feat", 1, { featured: true }));
    mocks.latestListings.mockRejectedValue(new Error("engine down"));
    html = await renderPage();
    expect(html).toContain('data-testid="home-featured"');
    expect(html).not.toContain('data-testid="home-recent"');
    html = await withMap(() => renderPage());
    expect(html).toContain('data-testid="home-featured-rows"');
    expect(html).not.toContain('data-testid="home-recent-rows"');

    mocks.featuredListings.mockRejectedValue(new SearchUnavailableError());
    for (const locale of ["fr", "ar"] as const) {
      html = await renderPage(locale);
      expect(html).toContain('data-testid="home-categories"');
      expect(html).toContain(MESSAGES[locale].Home.title);
      expect(html).not.toContain('data-testid="home-featured"');
      expect(html).not.toContain('data-testid="home-recent"');
      html = await withMap(() => renderPage(locale));
      expect(html).toContain('data-testid="home-category-rail"');
      expect(html).toContain(MESSAGES[locale].Home.title);
      expect(html).not.toContain('data-testid="result-rows"');
    }
  });

  it("hides empty sections (no listing online yet)", async () => {
    mocks.featuredListings.mockResolvedValue([]);
    mocks.latestListings.mockResolvedValue([]);
    let html = await renderPage();
    expect(html).not.toContain('data-testid="home-featured"');
    expect(html).not.toContain('data-testid="home-recent"');
    expect(html).toContain('data-testid="home-categories"');
    html = await withMap(() => renderPage());
    expect(html).not.toContain('data-testid="result-rows"');
    // The rest of the panel stays, "Voir toutes les annonces" included.
    expect(html).toContain(`href="/fr/recherche">${fr.Home.recent.all}`);
    expect(html).toContain('data-testid="home-category-rail"');
  });
});
