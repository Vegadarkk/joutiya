import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import type * as FeaturedRowModule from "@/components/search/featured-row";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { subcategoryById } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import { resetServerEnv } from "@/lib/env";
import { resetSearchEngine, setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";
import { sitemapShardOf, type SearchCard, type SearchDocument, type SearchEngine } from "@/lib/search/types";

// Category landing pages (design D15): ISR settings, config-first 404s, thresholds, markup (H1,
// lead, chips, city links, breadcrumb + JSON-LD, links to /recherche) on the in-memory engine. The
// grid and the À la Une row are L3b's components: stubbed here to the cards they receive.

vi.mock("@/components/search/results-grid", () => ({
  ResultsGrid: ({ cards }: { cards: SearchCard[] }) => (
    <ul data-testid="results-grid">
      {cards.map((card) => (
        <li key={card.id}>{card.slugId}</li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/search/featured-row", async (importOriginal) => ({
  ...(await importOriginal<typeof FeaturedRowModule>()),
  FeaturedRow: ({ cards }: { cards: SearchCard[] }) => <section data-testid="featured-row">{cards.map((card) => card.slugId).join(",")}</section>,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  // « Masquer les annonces exemples » refreshes the page through the router (src/components/examples).
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
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

const page = await import("@/app/[locale]/(public)/c/[category]/[[...rest]]/page");
const { default: LandingPage, generateMetadata, generateStaticParams } = page;

const NOW = Date.now();

function doc(id: string, subcategoryId: string, citySlug: string, overrides: Partial<SearchDocument> = {}): SearchDocument {
  const sub = subcategoryById(subcategoryId);
  const city = cityBySlug(citySlug);
  if (!sub || !city) throw new Error("fixture");
  return {
    id,
    slugId: `annonce-${id}`,
    title: `Annonce ${id}`,
    description: "",
    categoryText: "",
    placeText: "",
    attrsText: "",
    categoryId: sub.categoryId,
    subcategoryId,
    regionCode: city.regionCode,
    citySlug,
    sellerType: "individual",
    sellerPublicId: "abcdefghjk",
    price: 1000,
    priceNegotiable: false,
    isDonation: false,
    hasPhoto: false,
    photoCount: 0,
    sortAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    sitemapShard: sitemapShardOf(id),
    isBumped: false,
    _geo: { lat: city.lat, lng: city.lng },
    version: 1,
    ...overrides,
  };
}

type Rest = string[] | undefined;
const params = (category: string, rest?: Rest, locale = "fr") => ({ params: Promise.resolve({ locale, category, ...(rest ? { rest } : {}) }) });

async function render(category: string, rest?: Rest, locale: "fr" | "ar" = "fr"): Promise<string> {
  const tree = await LandingPage(params(category, rest, locale));
  const messages = locale === "ar" ? (await import("../../messages/ar.json")).default : fr;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

let engine: MemoryEngine;

beforeEach(async () => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
  engine = new MemoryEngine({ synonyms: {} });
  setSearchEngineForTests(engine);
  await engine.upsert([
    doc("a2345678", "voitures", "casablanca"),
    doc("b2345678", "voitures", "casablanca"),
    doc("c2345678", "voitures", "casablanca", { featuredUntil: NOW + 86_400_000 }),
    doc("d2345678", "voitures", "mohammedia"),
    doc("e2345678", "velos", "casablanca"),
    doc("f2345678", "velos", "rabat"),
  ]);
});
afterEach(() => {
  resetSearchEngine();
  resetServerEnv();
});

describe("category landing page", () => {
  it("is ISR for 10 minutes, rendered on first visit", () => {
    expect(page.revalidate).toBe(600);
    expect(page.dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("answers 404 for paths outside the config without asking the engine", async () => {
    const search = vi.fn(async () => {
      throw new Error("engine must not be called");
    });
    setSearchEngineForTests({ ...engine, search } as unknown as SearchEngine);
    for (const [category, rest] of [["inconnu", undefined], ["vehicules", ["vente"]], ["vehicules", ["atlantis"]], ["vehicules", ["casablanca", "voitures"]], ["vehicules", ["voitures", "casablanca", "x"]]] as [string, Rest][]) {
      await expect(LandingPage(params(category, rest))).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await generateMetadata(params(category, rest))).toEqual({});
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("renders a category page: heading, count, chips, À la Une, grid, cities, breadcrumb", async () => {
    const html = await render("vehicules");
    expect(html).toMatch(/<h1[^>]*>Véhicules au Maroc<\/h1>/);
    expect(html).toContain("6 annonces en ligne, les plus récentes en premier.");
    expect(html).toContain('href="/fr/recherche?categorie=vehicules"');
    expect(html).toContain("Voir les 6 annonces");
    // Chips: all + subcategories with listings, current one marked, counts.
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/fr\/c\/vehicules"|<a[^>]*href="\/fr\/c\/vehicules"[^>]*aria-current="page"/);
    expect(html).toContain('href="/fr/c/vehicules/voitures"');
    expect(html).toContain('href="/fr/c/vehicules/velos"');
    expect(html).not.toContain('href="/fr/c/vehicules/bateaux"');
    expect(html).toContain('data-testid="featured-row">annonce-c2345678<');
    // The featured listing is not repeated in the grid below.
    expect(html.match(/<li>annonce-/g)).toHaveLength(5);
    expect(html).not.toContain("<li>annonce-c2345678<");
    // Busiest cities first (ties: the larger city).
    expect(html).toContain("Véhicules par ville");
    const cities = [...html.matchAll(/href="\/fr\/c\/vehicules\/(casablanca|mohammedia|rabat)"/g)].map((match) => match[1]);
    expect(cities).toEqual(["casablanca", "rabat", "mohammedia"]);
    // Breadcrumb and its JSON-LD.
    expect(html).toContain('aria-label="Fil d&#x27;Ariane"');
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)?.[1] ?? "{}") as { "@type"?: string; itemListElement?: { name: string; item?: string }[] };
    expect(jsonLd["@type"]).toBe("BreadcrumbList");
    expect(jsonLd.itemListElement?.map((step) => [step.name, step.item])).toEqual([
      ["Accueil", "https://joutiya.ma/fr"],
      ["Véhicules", "https://joutiya.ma/fr/c/vehicules"],
    ]);
  });

  it("renders a subcategory x city page with nearby cities and the parent in the breadcrumb", async () => {
    const html = await render("vehicules", ["voitures", "casablanca"]);
    expect(html).toMatch(/<h1[^>]*>Voitures à Casablanca<\/h1>/);
    expect(html).toContain("3 annonces en ligne");
    expect(html).toContain('href="/fr/recherche?categorie=vehicules&amp;sous-categorie=voitures&amp;ville=casablanca"');
    expect(html).toContain("Voitures dans les villes proches");
    const nearby = html.slice(html.indexOf('id="landing-cities"'));
    expect(nearby).toContain('href="/fr/c/vehicules/voitures/mohammedia"');
    expect(nearby).not.toContain('href="/fr/c/vehicules/voitures/casablanca"');
    // The page's own chip is the current one.
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/fr\/c\/vehicules\/voitures\/casablanca"/);
    // Sibling chips stay in the city.
    expect(html).toContain('href="/fr/c/vehicules/velos/casablanca"');
    expect(html).toContain('href="/fr/c/vehicules/casablanca"');
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)?.[1] ?? "{}") as { itemListElement?: { item?: string }[] };
    expect(jsonLd.itemListElement?.map((step) => step.item)).toEqual([
      "https://joutiya.ma/fr",
      "https://joutiya.ma/fr/c/vehicules",
      "https://joutiya.ma/fr/c/vehicules/voitures",
      "https://joutiya.ma/fr/c/vehicules/voitures/casablanca",
    ]);
  });

  it("indexes pages with 3 listings or more, noindexes thin ones, 404s empty deeper ones", async () => {
    const indexed = await generateMetadata(params("vehicules", ["voitures", "casablanca"]));
    expect(indexed.robots).toBeUndefined();
    expect(indexed.title).toBe("Voitures à Casablanca : petites annonces");
    expect(indexed.description).toContain("3 annonces en ligne");
    expect(indexed.alternates).toEqual({
      canonical: "/fr/c/vehicules/voitures/casablanca",
      languages: { "fr-MA": "/fr/c/vehicules/voitures/casablanca", "ar-MA": "/ar/c/vehicules/voitures/casablanca", "x-default": "/fr/c/vehicules/voitures/casablanca" },
    });
    const thin = await generateMetadata(params("vehicules", ["velos"]));
    expect(thin.robots).toEqual({ index: false, follow: true });
    await expect(render("vehicules", ["velos"])).resolves.toContain("Voir les 2 annonces");
    await expect(LandingPage(params("vehicules", ["bateaux"]))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(LandingPage(params("vehicules", ["tanger"]))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata(params("vehicules", ["bateaux", "tanger"]))).toEqual({});
  });

  it("keeps an empty category page at 200, noindex, with a way forward", async () => {
    const html = await render("animaux");
    expect(html).toMatch(/<h1[^>]*>Animaux au Maroc<\/h1>/);
    expect(html).toContain(fr.Seo.emptyTitle.replace("'", "&#x27;"));
    expect(html).toContain('href="/fr/deposer"');
    expect(html).not.toContain("results-grid");
    expect(html).not.toContain("/recherche");
    const metadata = await generateMetadata(params("animaux"));
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.description).toBe("Animaux au Maroc : achetez et vendez entre particuliers et professionnels sur Aalan. Déposez votre annonce gratuitement.");
  });

  it("speaks Arabic with Arabic city names", async () => {
    const html = await render("vehicules", ["casablanca"], "ar");
    expect(html).toMatch(/<h1[^>]*>مركبات في الدار البيضاء<\/h1>/);
    expect(html).toContain('href="/ar/c/vehicules/voitures/casablanca"');
    const metadata = await generateMetadata(params("vehicules", ["casablanca"], "ar"));
    expect(metadata.alternates).toMatchObject({ canonical: "/ar/c/vehicules/casablanca" });
  });
});
