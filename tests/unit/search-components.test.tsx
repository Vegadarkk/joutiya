import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { ListingCard } from "@/components/listing/listing-card";
import { ActiveFilterChips } from "@/components/search/active-filter-chips";
import { BoostBadge } from "@/components/search/boost-badge";
import { challengeUrl, submitSearchChallenge } from "@/components/search/challenge-client";
import { SearchCityCombobox } from "@/components/search/city-combobox";
import { CriteriaFilters } from "@/components/search/criteria-filters";
import { FeaturedRow } from "@/components/search/featured-row";
import { categoryValue, FiltersSheet, withCategory, withLocation } from "@/components/search/filters-sheet";
import { LocationField } from "@/components/search/location-field";
import { Pagination } from "@/components/search/pagination";
import { RefineChips } from "@/components/search/refine-chips";
import { ResultsGrid } from "@/components/search/results-grid";
import { carriedInputs, SearchBar, submittedParams } from "@/components/search/search-bar";
import { SearchChallenge } from "@/components/search/search-challenge";
import { SearchEmpty } from "@/components/search/search-empty";
import { SearchError } from "@/components/search/search-error";
import { PendingRegion, SearchLink, SearchNavigationProvider } from "@/components/search/search-navigation";
import { SearchResultsSkeleton } from "@/components/search/search-skeleton";
import { SortSelect } from "@/components/search/sort-select";
import type { Locale } from "@/config/site";
import { groupDigits } from "@/lib/listings/client/format";
import { parseSearchParams, searchPath } from "@/lib/search/params";
import type { SearchCard } from "@/lib/search/types";

// Server markup of the search UI building blocks (lot L3b), French and Arabic. Interaction runs in
// the browser pass (Playwright); here: structure, labels, links, ARIA and the pure helpers.

vi.mock("@/lib/storage/keys", () => ({ mediaBaseUrl: () => "https://media.joutiya.test" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      <SearchNavigationProvider>{node}</SearchNavigationProvider>
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
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const url = (query: string) => parseSearchParams(new URLSearchParams(query));

const MEDIA = "https://media.joutiya.test";

function searchCard(id: string, overrides: Partial<SearchCard> = {}): SearchCard {
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

describe("ListingCard (phase 4 additions)", () => {
  it("keeps the phase 3 card unchanged without badge, action or priority", () => {
    const html = render(<ListingCard listing={searchCard("abcd2345")} mediaBaseUrl={MEDIA} locale="fr" />);
    expect(html).not.toContain("data-badge");
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("fetchPriority");
    expect(html).not.toContain("z-10");
  });

  it("carries the §8 mentions with their info-bubble text for screen readers", () => {
    const featured = render(<ListingCard listing={searchCard("abcd2345")} mediaBaseUrl={MEDIA} locale="fr" badge="featured" />);
    expect(featured).toContain('data-badge="featured"');
    expect(featured).toMatch(/<button[^>]*data-badge="featured"[^>]*aria-describedby="[^"]+-info"/);
    expect(text(featured)).toContain(fr.ListingCard.featured);
    expect(text(featured)).toContain(fr.ListingCard.featuredInfo);
    const bumped = render(<ListingCard listing={searchCard("abcd2345")} mediaBaseUrl={MEDIA} locale="ar" badge="bumped" />, "ar");
    expect(text(bumped)).toContain(ar.ListingCard.bumped);
    expect(text(bumped)).toContain(ar.ListingCard.bumpedInfo);
    expect(bumped).toContain("relative z-10");
  });

  it("puts the action above the stretched link and loads priority photos eagerly", () => {
    const html = render(<ListingCard listing={searchCard("abcd2345")} mediaBaseUrl={MEDIA} locale="fr" action={<button type="button">heart</button>} priority />);
    expect(html).toMatch(/<div class="absolute top-1 end-1 z-10"><button type="button">heart<\/button><\/div>/);
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
  });
});

describe("ResultsGrid", () => {
  it("renders every card with its mention, the action slot and the first photos eager", () => {
    const cards = [searchCard("aaaa2345", { bumped: true }), searchCard("bbbb2345"), searchCard("cccc2345")];
    const html = render(<ResultsGrid cards={cards} locale="fr" priorityCount={2} renderAction={(card) => <span data-action={card.id} />} />);
    expect(html.match(/data-testid="listing-card"/g)).toHaveLength(3);
    expect(html.match(/data-badge="bumped"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain('data-action="cccc2345"');
    expect(html.match(/loading="eager"/g)).toHaveLength(2);
    expect(html).toContain(`src="${MEDIA}/listings/aaaa2345/photo0001-s.webp"`);
    expect(html).toContain('href="/fr/annonce/velo-aaaa2345"');
  });
});

describe("FeaturedRow", () => {
  it("renders nothing without cards", () => {
    expect(render(<FeaturedRow cards={[]} locale="fr" />)).toBe("");
  });

  it("sets the sponsored slots apart, every card marked À la Une · Sponsorisé", () => {
    const html = render(<FeaturedRow cards={[searchCard("aaaa2345", { featured: true }), searchCard("bbbb2345", { featured: true })]} locale="fr" />);
    expect(html).toContain('data-testid="featured-row"');
    expect(html).toContain('aria-labelledby="featured-row-title"');
    expect(text(html)).toContain(fr.SearchPage.featured.title);
    expect(text(html)).toContain(fr.SearchPage.featured.sponsored);
    expect(html).toContain(`aria-label="${escape(fr.SearchPage.featured.infoLabel)}"`);
    expect(html.match(/<button[^>]*data-badge="featured"/g)).toHaveLength(2);
    const arabic = render(<FeaturedRow cards={[searchCard("aaaa2345", { featured: true })]} locale="ar" />, "ar");
    expect(text(arabic)).toContain(ar.SearchPage.featured.title);
    expect(text(arabic)).toContain(ar.ListingCard.featured);
  });
});

describe("ActiveFilterChips", () => {
  it("links each chip to the search without it, plus clear all", () => {
    const params = url("q=velo&categorie=vehicules&ville=rabat&prix-max=2000&page=3");
    const html = render(<ActiveFilterChips params={params} locale="fr" />);
    expect(html).toContain(`aria-label="${escape(fr.SearchFilters.active)}"`);
    expect(html).toContain('href="/fr/recherche?q=velo&amp;ville=rabat&amp;prix-max=2000"');
    expect(html).toContain('href="/fr/recherche?q=velo&amp;categorie=vehicules&amp;prix-max=2000"');
    expect(html).toContain(`aria-label="Retirer le filtre Rabat"`);
    expect(html).toContain('href="/fr/recherche?q=velo"');
    expect(text(html)).toContain(fr.SearchFilters.clearAll);
  });

  it("renders nothing without filters and Arabic labels otherwise", () => {
    expect(render(<ActiveFilterChips params={url("q=velo")} locale="fr" />)).toBe("");
    const html = render(<ActiveFilterChips params={url("ville=casablanca")} locale="ar" />, "ar");
    expect(html).toContain('href="/ar/recherche"');
    expect(text(html)).toContain("الدار البيضاء");
    expect(text(html)).not.toContain(ar.SearchFilters.clearAll);
  });
});

describe("RefineChips", () => {
  it("offers the categories with their counts, then nothing below a subcategory", () => {
    const facets = { categories: { vehicules: 1200, mode: 3 }, subcategories: {} };
    const html = render(<RefineChips params={url("q=velo")} facets={facets} />);
    expect(html).toContain(`aria-label="${escape(fr.SearchPage.refine.categories)}"`);
    expect(html).toContain('href="/fr/recherche?q=velo&amp;categorie=vehicules"');
    expect(text(html)).toContain(`${fr.Categories.vehicules.name} 1 200`);
    expect(html).toContain(groupDigits("1200"));
    expect(render(<RefineChips params={url("sous-categorie=velos")} facets={facets} />)).toBe("");
    expect(render(<RefineChips params={{}} facets={{ categories: { mode: 3 }, subcategories: {} }} />)).toBe("");
  });
});

describe("Pagination", () => {
  it("renders nothing for a single page", () => {
    expect(render(<Pagination params={{}} page={1} totalPages={1} />)).toBe("");
  });

  it("links the previous, next and nearby pages, marking the current one", () => {
    const html = render(<Pagination params={url("q=velo")} page={5} totalPages={20} />);
    expect(html).toContain(`aria-label="${fr.SearchPage.pagination.label}"`);
    expect(html).toContain('rel="prev"');
    expect(html).toContain('href="/fr/recherche?q=velo&amp;page=4"');
    expect(html).toContain('href="/fr/recherche?q=velo&amp;page=6"');
    expect(html).toContain('href="/fr/recherche?q=velo"');
    expect(html).toMatch(/<span aria-current="page"[^>]*>5<\/span>/);
    expect(text(html)).toContain("Page 5 sur 20");
    expect(html).toContain('href="/fr/recherche?q=velo&amp;page=20"');
  });

  it("caps at 50 pages and says so on the last one", () => {
    const html = render(<Pagination params={{}} page={50} totalPages={80} total={5000} />);
    expect(html).not.toContain('rel="next"');
    expect(text(html)).toContain("Seules les 50 premières pages");
    expect(text(render(<Pagination params={{}} page={2} totalPages={3} />, "ar"))).toContain("الصفحة 2 من 3");
  });
});

describe("SearchEmpty", () => {
  it("invites to post when the site has no listing yet", () => {
    const html = render(<SearchEmpty params={{}} locale="fr" />);
    expect(text(html)).toContain(fr.SearchPage.empty.blankTitle);
    expect(html).toContain('href="/fr/deposer"');
  });

  it("offers to remove a filter, widen the place or clear everything", () => {
    const html = render(<SearchEmpty params={url("q=velo&ville=rabat&prix-max=100")} locale="fr" action={<span data-slot="save" />} />);
    expect(text(html)).toContain(fr.SearchPage.empty.title);
    expect(text(html)).toContain(fr.SearchPage.empty.bodyWords);
    expect(html).toContain('href="/fr/recherche?q=velo&amp;prix-max=100"');
    expect(text(html)).toContain("Chercher dans toute la région Rabat-Salé-Kénitra");
    expect(html).toContain('href="/fr/recherche?q=velo&amp;region=04&amp;prix-max=100"');
    expect(text(html)).toContain(fr.SearchPage.empty.widenCountry);
    expect(text(html)).toContain(fr.SearchPage.empty.clearAll);
    expect(html).toContain('data-slot="save"');
  });

  it("sends a stale page back to page 1, in Arabic too", () => {
    const html = render(<SearchEmpty params={url("q=velo&page=9")} locale="ar" outOfRange />, "ar");
    expect(text(html)).toContain(ar.SearchPage.empty.outOfRangeTitle);
    expect(html).toContain('href="/ar/recherche?q=velo"');
  });
});

describe("SearchError", () => {
  it("explains an engine outage with retry and home", () => {
    const html = render(<SearchError kind="unavailable" />);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(fr.SearchPage.error.title);
    expect(text(html)).toContain(fr.SearchPage.error.retry);
    expect(html).toContain('href="/fr"');
  });

  it("gives the wait of a rate limit", () => {
    expect(text(render(<SearchError kind="rate_limited" retryAfter={120} />))).toContain("réessayez dans 2 minutes");
    expect(text(render(<SearchError kind="rate_limited" />, "ar"))).toContain(ar.SearchPage.rateLimited.later);
  });
});

describe("SearchChallenge", () => {
  it("asks for a check in place of the results", () => {
    const html = render(<SearchChallenge params={url("q=velo")} />);
    expect(html).toContain('data-testid="search-challenge"');
    expect(text(html)).toContain(fr.SearchPage.challenge.title);
    expect(html).toContain('data-turnstile="pending"');
    expect(text(render(<SearchChallenge params={{}} />, "ar"))).toContain(ar.SearchPage.challenge.body);
  });
});

describe("submitSearchChallenge", () => {
  const response = (status: number, body?: unknown, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

  it("sends the token with the same search to the API", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(200, { hits: [] }));
    expect(await submitSearchChallenge(url("q=velo&ville=rabat"), "token-1", fetcher)).toEqual({ kind: "passed" });
    const [target, init] = fetcher.mock.calls[0]!;
    expect(target).toBe("/api/search?q=velo&ville=rabat");
    expect((init?.headers as Record<string, string>)["x-turnstile-token"]).toBe("token-1");
    expect(init?.credentials).toBe("same-origin");
    expect(challengeUrl({})).toBe("/api/search");
  });

  it("maps refusals: token, limits, outage, network", async () => {
    expect(await submitSearchChallenge({}, "t", async () => response(403, { error: { code: "turnstile_failed" } }))).toEqual({ kind: "failed" });
    expect(await submitSearchChallenge({}, "t", async () => response(429, undefined, { "Retry-After": "90" }))).toEqual({ kind: "limited", retryAfter: 90 });
    expect(await submitSearchChallenge({}, "t", async () => response(429))).toEqual({ kind: "limited", retryAfter: undefined });
    expect(await submitSearchChallenge({}, "t", async () => response(503, { error: { code: "search_unavailable" } }))).toEqual({ kind: "error" });
    expect(await submitSearchChallenge({}, "t", async () => response(403, { error: { code: "forbidden" } }))).toEqual({ kind: "error" });
    expect(
      await submitSearchChallenge({}, "t", async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("SortSelect", () => {
  it("lists the sorts that apply and selects the current one", () => {
    const html = render(<SortSelect params={url("q=velo&ville=rabat&tri=prix-croissant")} />);
    expect(html).toContain('<option value="relevance">Pertinence</option>');
    expect(html).toContain('<option value="distance">');
    expect(html).toMatch(/<option value="price_asc" selected="">/);
    expect(render(<SortSelect params={{}} />)).not.toContain('value="relevance"');
    expect(text(render(<SortSelect params={{}} />, "ar"))).toContain(ar.SearchFilters.sort.recent);
  });
});

describe("SearchBar", () => {
  it("is a GET form that keeps the other filters as hidden inputs", () => {
    const params = url("q=velo&categorie=vehicules&ville=rabat&rayon=10&tri=prix-croissant&page=2");
    const html = render(<SearchBar params={params} />);
    expect(html).toContain('action="/fr/recherche"');
    expect(html).toContain('role="search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="velo"');
    expect(html).toContain('<input type="hidden" name="ville" value="rabat"/>');
    expect(html).toContain('<input type="hidden" name="categorie" value="vehicules"/>');
    expect(html).toContain('<input type="hidden" name="tri" value="prix-croissant"/>');
    expect(html).not.toContain('name="page"');
    expect(html).not.toContain('name="rayon"');
    expect(carriedInputs(params)).toEqual([
      ["categorie", "vehicules"],
      ["tri", "prix-croissant"],
    ]);
  });

  it("submits new words and place, dropping the old radius, district and page", () => {
    const params = url("q=velo&categorie=vehicules&ville=rabat&rayon=10&page=2");
    expect(searchPath(submittedParams(params, "  velo   electrique ", { city: "rabat" }))).toBe("/recherche?q=velo+electrique&categorie=vehicules&ville=rabat&rayon=10");
    expect(searchPath(submittedParams(params, "velo", { region: "06" }))).toBe("/recherche?q=velo&categorie=vehicules&region=06");
    expect(searchPath(submittedParams(url("q=velo&tri=pertinence"), "", {}))).toBe("/recherche");
  });
});

describe("FiltersSheet", () => {
  it("renders its trigger with the number of active filters", () => {
    const html = render(<FiltersSheet params={url("categorie=vehicules&photo=1")} facets={{ categories: {}, subcategories: {} }} />);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Filtres, 2 actifs"');
    expect(text(render(<FiltersSheet params={{}} />, "ar"))).toContain(ar.SearchFilters.open);
  });

  it("encodes and applies the category choice, dropping criteria that no longer apply", () => {
    expect(categoryValue({})).toBe("");
    expect(categoryValue({ category: "vehicules" })).toBe("c:vehicules");
    expect(categoryValue({ category: "vehicules", subcategory: "velos" })).toBe("s:velos");
    const draft = url("sous-categorie=voitures&f-fuel=diesel&etat=good");
    expect(withCategory(draft, "s:voitures").criteria).toEqual(draft.criteria);
    const bikes = withCategory(draft, "s:velos");
    expect(bikes).toMatchObject({ category: "vehicules", subcategory: "velos" });
    expect(bikes.criteria).toBeUndefined();
    expect(bikes.conditions).toEqual(["good"]);
    expect(withCategory(draft, "s:location").conditions).toBeUndefined();
    expect(withCategory(draft, "c:mode")).toMatchObject({ category: "mode" });
    expect(withCategory(draft, "c:mode").subcategory).toBeUndefined();
    expect(withCategory(draft, "").category).toBeUndefined();
  });

  it("applies a place, dropping the radius, district and distance sort of the old city", () => {
    const draft = url("ville=rabat&rayon=10&tri=distance");
    expect(withLocation(draft, { city: "rabat" })).toBe(draft);
    const region = withLocation(draft, { region: "06" });
    expect(region).toMatchObject({ region: "06", city: undefined });
    expect(region.radiusKm).toBeUndefined();
    expect(region.sort).toBeUndefined();
    expect(withLocation(draft, { city: "fes" })).toMatchObject({ city: "fes", sort: "distance" });
  });
});

describe("CriteriaFilters", () => {
  it("renders option lists, ranges with units and yes-only switches", () => {
    const html = render(<CriteriaFilters categoryId="vehicules" subcategoryId="voitures" value={url("sous-categorie=voitures&f-fuel=diesel").criteria} onChange={() => undefined} />);
    // 63 brands: a checklist; 5 fuels: chips.
    expect(html).toMatch(/<input type="checkbox"[^>]* name="car-brand-dacia"/);
    expect(html).toMatch(/role="checkbox" aria-checked="true"[^>]*>.*Diesel/);
    expect(text(html)).toContain(fr.Criteria.mileage.label);
    expect(html).toContain(">km</span>");
    expect(html).toContain('role="switch"');
    expect(text(html)).toContain(fr.Criteria["first-hand"].label);
    expect(html).not.toContain(fr.Criteria.model.label);
    expect(render(<CriteriaFilters categoryId="divers" subcategoryId="autres" value={undefined} onChange={() => undefined} />)).toBe("");
  });
});

describe("SearchCityCombobox", () => {
  it("shows the chosen place, a clear button and its hidden form input", () => {
    const html = render(<SearchCityCombobox value={{ city: "rabat" }} onChange={() => undefined} label="Lieu" names={{ city: "ville", region: "region" }} />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="Rabat"');
    expect(html).toContain(`aria-label="${fr.Search.location.clear}"`);
    expect(html).toContain('<input type="hidden" name="ville" value="rabat"/>');
    expect(html).toMatch(/role="listbox"[^>]*class="[^"]*hidden/);
    expect(html).not.toMatch(/<input[^>]*role="combobox"[^>]*name=/);
  });

  it("says the whole country when empty and submits a region as region", () => {
    const empty = render(<SearchCityCombobox value={{}} onChange={() => undefined} label="Lieu" />);
    expect(empty).toContain(`placeholder="${fr.Search.location.all}"`);
    expect(empty).not.toContain(fr.Search.location.clear);
    const region = render(<SearchCityCombobox value={{ region: "06" }} onChange={() => undefined} label="Lieu" names={{ city: "ville", region: "region" }} locale="ar" />, "ar");
    expect(region).toContain('value="الدار البيضاء-سطات"');
    expect(region).toContain('<input type="hidden" name="region" value="06"/>');
  });

  it("serves the home form through LocationField", () => {
    const html = render(<LocationField initial={{ city: "fes" }} />);
    expect(html).toContain('<input type="hidden" name="ville" value="fes"/>');
    expect(html).toContain(`>${fr.Search.location.label}</label>`);
  });
});

describe("navigation helpers", () => {
  it("renders search links with real hrefs and a busy-aware results region", () => {
    const html = render(
      <PendingRegion>
        <SearchLink params={url("q=velo&page=2")}>next</SearchLink>
      </PendingRegion>,
    );
    expect(html).toContain('href="/fr/recherche?q=velo&amp;page=2"');
    expect(html).not.toContain("aria-busy");
  });

  it("renders the loading footprint with a status for screen readers", () => {
    const html = render(<SearchResultsSkeleton count={4} />);
    expect(html).toContain('role="status"');
    expect(text(html)).toContain(fr.SearchPage.loading);
  });

  it("renders the badge on its own", () => {
    expect(text(render(<BoostBadge kind="bumped" />))).toContain(fr.ListingCard.bumped);
  });
});
