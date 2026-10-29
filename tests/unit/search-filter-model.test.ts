import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { makeFilterLabels, type LooseTranslator } from "@/components/search/filter-labels";
import {
  activeFilterKeys,
  cardBadge,
  clearFilters,
  conditionApplies,
  countFilters,
  describeFilters,
  districtLabel,
  filterableCriteria,
  paginationItems,
  refinements,
  searchLinkHref,
  searchTitle,
  setCriterion,
  sortOptions,
  widenings,
  withoutFilter,
  withPage,
  withSort,
  type FilterLabels,
} from "@/components/search/filter-model";
import type { Locale } from "@/config/site";
import { parseSearchParams, searchPath, type SearchParams } from "@/lib/search/params";

// Pure model of the search filters (lot L3b): chips, removal, sorts, pages, refinements, titles.

const NNBSP = " ";
const NBSP = " ";

function labels(locale: Locale): FilterLabels {
  const messages = locale === "ar" ? ar : fr;
  const loose = (namespace: string) => createTranslator({ locale, messages, namespace: namespace as never }) as unknown as LooseTranslator;
  return makeFilterLabels({ chips: loose("SearchFilters.chips"), categories: loose("Categories"), criteria: loose("Criteria"), units: loose("Listing.units") }, locale);
}

function title(locale: Locale) {
  const t = createTranslator({ locale, messages: locale === "ar" ? ar : fr, namespace: "SearchPage.title" });
  return (key: "all" | "query" | "inCity" | "inRegion", values?: Record<string, string>) => t(key, values as never);
}

const url = (query: string) => parseSearchParams(new URLSearchParams(query));

const full = url(
  "q=golf&sous-categorie=voitures&ville=casablanca&rayon=20&prix-min=1000&prix-max=50000&vendeur=particulier&photo=1&etat=good,like_new&f-car-brand=dacia,renault,peugeot&f-mileage-max=150000&f-first-hand=1&f-year-min=2015&tri=prix-croissant&page=3",
);

describe("activeFilterKeys / countFilters", () => {
  it("lists every active filter in display order, never the words, sort or page", () => {
    expect(activeFilterKeys(full)).toEqual(["category", "location", "price", "sellerType", "withPhoto", "conditions", "criterion:car-brand", "criterion:first-hand", "criterion:mileage", "criterion:year"]);
    expect(countFilters(full)).toBe(10);
    expect(countFilters(url("q=velo&tri=recentes&page=2"))).toBe(0);
  });

  it("shows a shop as one filter (it implies Pro sellers)", () => {
    expect(activeFilterKeys(url("boutique=abcdefghjk"))).toEqual(["shop"]);
    expect(activeFilterKeys(url("vendeur-id=abcdefghjk&don=1&ville=rabat&quartier=Agdal"))).toEqual(["location", "district", "seller", "donation"]);
  });
});

describe("withoutFilter", () => {
  it("removes one filter, resets the page and keeps the rest", () => {
    const next = withoutFilter(full, "price");
    expect(next.priceMin).toBeUndefined();
    expect(next.priceMax).toBeUndefined();
    expect(next.page).toBeUndefined();
    expect(next.city).toBe("casablanca");
    expect(next.criteria?.["car-brand"]).toEqual({ kind: "options", values: ["dacia", "renault", "peugeot"] });
  });

  it("goes from a subcategory back to its category, then to every category", () => {
    const sub = withoutFilter(full, "category");
    expect(sub.subcategory).toBeUndefined();
    expect(sub.category).toBe("vehicules");
    expect(sub.criteria).toBeUndefined();
    expect(withoutFilter(sub, "category").category).toBeUndefined();
  });

  it("drops radius, district and the distance sort with the place", () => {
    const near = url("ville=rabat&rayon=10&tri=distance");
    const next = withoutFilter(near, "location");
    expect(next).toEqual({});
    expect(withoutFilter(url("ville=rabat&quartier=Agdal"), "district")).toEqual({ city: "rabat", region: "04" });
  });

  it("removes one criterion and the whole map when it was the last", () => {
    expect(Object.keys(withoutFilter(full, "criterion:mileage").criteria ?? {})).toEqual(["car-brand", "first-hand", "year"]);
    const one = url("sous-categorie=voitures&f-first-hand=1");
    expect(withoutFilter(one, "criterion:first-hand").criteria).toBeUndefined();
  });

  it("removes a shop with its implied Pro seller type", () => {
    expect(withoutFilter(url("boutique=abcdefghjk"), "shop")).toEqual({});
  });
});

describe("clearFilters", () => {
  it("keeps the words and the sort only", () => {
    expect(searchPath(clearFilters(full))).toBe("/recherche?q=golf&tri=prix-croissant");
    expect(clearFilters(url("ville=rabat&tri=distance"))).toEqual({});
  });
});

describe("describeFilters", () => {
  it("writes French chips with grouped numbers and units", () => {
    const chips = describeFilters(full, "fr", labels("fr"));
    const byKey = Object.fromEntries(chips.map((chip) => [chip.key, chip.label]));
    expect(byKey.category).toBe(fr.Categories.vehicules.sub.voitures);
    expect(byKey.location).toBe(`Casablanca + 20 km`);
    expect(byKey.price).toBe(`1${NNBSP}000${NBSP}DH – 50${NNBSP}000${NBSP}DH`);
    expect(byKey.sellerType).toBe(fr.SearchFilters.chips.sellerIndividual);
    expect(byKey.withPhoto).toBe(fr.SearchFilters.chips.withPhoto);
    expect(byKey.conditions).toBe(`État : ${fr.Criteria.condition.options.like_new}, ${fr.Criteria.condition.options.good}`);
    expect(byKey["criterion:car-brand"]).toBe(`${fr.Criteria["car-brand"].label} : Dacia, Renault +1`);
    expect(byKey["criterion:mileage"]).toBe(`${fr.Criteria.mileage.label} : jusqu'à 150${NNBSP}000 km`);
    expect(byKey["criterion:year"]).toBe(`${fr.Criteria.year.label} : dès 2015`);
    expect(byKey["criterion:first-hand"]).toBe(fr.Criteria["first-hand"].label);
    for (const chip of chips) expect(chip.without.page).toBeUndefined();
  });

  it("writes Arabic chips with Arabic names, separators and units", () => {
    const chips = describeFilters(url("sous-categorie=voitures&ville=casablanca&prix-min=500&etat=good,like_new&f-mileage-min=1000&f-mileage-max=90000"), "ar", labels("ar"));
    const byKey = Object.fromEntries(chips.map((chip) => [chip.key, chip.label]));
    expect(byKey.category).toBe(ar.Categories.vehicules.sub.voitures);
    expect(byKey.location).toBe("الدار البيضاء");
    expect(byKey.price).toBe(`من 500${NBSP}درهم`);
    expect(byKey.conditions).toBe(`الحالة: ${ar.Criteria.condition.options.like_new}، ${ar.Criteria.condition.options.good}`);
    expect(byKey["criterion:mileage"]).toBe(`${ar.Criteria.mileage.label}: 1${NNBSP}000 كلم – 90${NNBSP}000 كلم`);
  });

  it("names a region, a district and a price ceiling", () => {
    const chips = describeFilters(url("region=02&prix-max=300"), "fr", labels("fr"));
    expect(chips.map((chip) => chip.label)).toEqual(["L'Oriental", `Jusqu'à 300${NBSP}DH`]);
    const district = describeFilters(url("ville=rabat&quartier=hay%20riad"), "fr", labels("fr"));
    expect(district[1]?.label).toBe("Quartier Hay Riad");
  });
});

describe("sorts", () => {
  it("offers relevance only with words and distance only with a city", () => {
    expect(sortOptions({})).toEqual(["recent", "price_asc", "price_desc"]);
    expect(sortOptions({ q: "velo", city: "rabat" })).toEqual(["relevance", "recent", "price_asc", "price_desc", "distance"]);
    expect(sortOptions({ promo: true })).toEqual(["recent", "price_asc", "price_desc", "discount"]);
  });

  it("changes the sort, back to page 1, the default sort leaving the URL", () => {
    expect(searchPath(withSort(url("q=velo&page=4"), "price_desc"))).toBe("/recherche?q=velo&tri=prix-decroissant");
    expect(searchPath(withSort(url("q=velo&tri=recentes"), "relevance"))).toBe("/recherche?q=velo");
  });
});

describe("paginationItems", () => {
  it("shows the first, the last and a window, with gaps", () => {
    expect(paginationItems(1, 1)).toEqual([1]);
    expect(paginationItems(1, 5)).toEqual([1, 2, "gap", 5]);
    expect(paginationItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationItems(10, 30)).toEqual([1, "gap", 9, 10, 11, "gap", 30]);
    expect(paginationItems(10, 30, 2)).toEqual([1, "gap", 8, 9, 10, 11, 12, "gap", 30]);
  });

  it("fills a one-page gap and caps at 50 pages", () => {
    expect(paginationItems(4, 9)).toEqual([1, 2, 3, 4, 5, "gap", 9]);
    expect(paginationItems(60, 80)).toEqual([1, "gap", 49, 50]);
    expect(searchPath(withPage(url("q=velo"), 2))).toBe("/recherche?q=velo&page=2");
    expect(searchPath(withPage(url("q=velo&page=2"), 1))).toBe("/recherche?q=velo");
  });
});

describe("refinements", () => {
  const facets = { categories: { vehicules: 12, immobilier: 0, mode: 3 }, subcategories: { voitures: 9, velos: 3, bateaux: 0 } };

  it("lists categories with listings in tree order while none is chosen", () => {
    const items = refinements(url("q=velo&page=3"), facets);
    expect(items.map((item) => [item.id, item.count])).toEqual([
      ["vehicules", 12],
      ["mode", 3],
    ]);
    expect(searchPath(items[0]!.params)).toBe("/recherche?q=velo&categorie=vehicules");
  });

  it("then the subcategories of the chosen category, then nothing", () => {
    expect(refinements(url("categorie=vehicules"), facets).map((item) => item.id)).toEqual(["voitures", "velos"]);
    expect(refinements(url("sous-categorie=voitures"), facets)).toEqual([]);
    expect(refinements({}, undefined)).toEqual([]);
  });
});

describe("widenings", () => {
  it("offers the city's region, then the whole country", () => {
    const options = widenings(url("q=velo&ville=rabat&rayon=10&tri=distance&page=2"));
    expect(options.map((option) => [option.kind, searchPath(option.params)])).toEqual([
      ["region", "/recherche?q=velo&region=04"],
      ["country", "/recherche?q=velo"],
    ]);
    expect(widenings(url("region=04")).map((option) => option.kind)).toEqual(["country"]);
    expect(widenings(url("q=velo"))).toEqual([]);
  });
});

describe("criteria helpers", () => {
  it("lists the filterable criteria of a subcategory (no text criteria)", () => {
    expect(filterableCriteria("vehicules", "voitures").map((criterion) => criterion.id)).toEqual(["car-brand", "year", "mileage", "fuel", "gearbox", "fiscal-power", "origin", "body-type", "doors", "color", "first-hand", "service-history", "vehicle-warranty", "trade-in"]);
    expect(filterableCriteria(undefined, undefined)).toEqual([]);
  });

  it("sets and clears one criterion, undefined once empty", () => {
    const one = setCriterion(undefined, "fuel", { kind: "options", values: ["diesel"] });
    expect(one).toEqual({ fuel: { kind: "options", values: ["diesel"] } });
    expect(setCriterion(one, "fuel", { kind: "options", values: [] })).toBeUndefined();
    expect(setCriterion(one, "year", { kind: "range" })).toEqual(one);
    expect(setCriterion(one, "fuel", undefined)).toBeUndefined();
  });

  it("applies the condition filter only where the subcategory has one", () => {
    expect(conditionApplies({})).toBe(true);
    expect(conditionApplies({ subcategory: "velos" })).toBe(true);
    expect(conditionApplies({ subcategory: "location" })).toBe(false);
  });
});

describe("searchTitle", () => {
  it("names the words, else the (sub)category, else all listings, then the place", () => {
    expect(searchTitle(url("q=velo&ville=rabat"), "fr", labels("fr"), title("fr"))).toBe("« velo » à Rabat");
    expect(searchTitle(url("sous-categorie=voitures&region=02"), "fr", labels("fr"), title("fr"))).toBe(`${fr.Categories.vehicules.sub.voitures}, région L'Oriental`);
    expect(searchTitle({}, "fr", labels("fr"), title("fr"))).toBe(fr.SearchPage.title.all);
    expect(searchTitle(url("categorie=immobilier&ville=casablanca"), "ar", labels("ar"), title("ar"))).toBe(`${ar.Categories.immobilier.name} في الدار البيضاء`);
  });
});

describe("small helpers", () => {
  it("title-cases Latin district keys only", () => {
    expect(districtLabel("hay riad")).toBe("Hay Riad");
    expect(districtLabel("المعاريف")).toBe("المعاريف");
  });

  it("gives the §8 mention of a card", () => {
    expect(cardBadge({ featured: true, bumped: true })).toBe("featured");
    expect(cardBadge({ featured: false, bumped: true })).toBe("bumped");
    expect(cardBadge({ featured: false, bumped: false })).toBeUndefined();
  });

  it("builds the next-intl href of a search", () => {
    const params: SearchParams = { q: "velo", city: "rabat", page: 2 };
    expect(searchLinkHref(params)).toEqual({ pathname: "/recherche", query: { q: "velo", ville: "rabat", page: "2" } });
  });
});
