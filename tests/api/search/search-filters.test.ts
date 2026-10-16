import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setSearchEngineForTests } from "@/lib/search/engine";
import type { SearchApiResponse } from "@/lib/contracts/search";
import { SearchUnavailableError, type SearchDocument, type SearchEngine } from "@/lib/search/types";
import { NOW, doc, search, serve, type ErrorBody } from "./search-helpers";

// GET /api/search on the memory engine (design D5-D8, D2): every filter, the sorts, the radius
// around a city centroid, Darija synonyms across scripts, the approximate retry, page mode, the
// À la Une slots, canonical parameters in the answer, and the honest 503 when the engine is down.

const HOUR = 60 * 60 * 1000;
const PRO = "prxshp2kzm";

const docs = {
  logan: doc({
    title: "Voiture Dacia Logan diesel",
    categoryId: "vehicules",
    subcategoryId: "voitures",
    citySlug: "casablanca",
    district: "maarif",
    price: 75_000,
    sellerType: "pro",
    sellerPublicId: PRO,
    hasPhoto: true,
    photo: { id: "ph1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    photoCount: 4,
    a_car_brand: "dacia",
    a_year: 2016,
    a_mileage: 120_000,
    a_fuel: "diesel",
    sortAt: NOW - 5 * HOUR,
  }),
  clio: doc({ title: "Renault Clio 4 essence", categoryId: "vehicules", subcategoryId: "voitures", citySlug: "rabat", price: 98_000, a_car_brand: "renault", a_year: 2019, a_mileage: 60_000, a_fuel: "essence", sortAt: NOW - 2 * HOUR }),
  peugeot: doc({
    title: "Peugeot 208 automatique",
    categoryId: "vehicules",
    subcategoryId: "voitures",
    citySlug: "casablanca",
    price: 120_000,
    a_car_brand: "peugeot",
    a_year: 2021,
    featuredUntil: NOW + 24 * HOUR,
    sortAt: NOW - 30 * HOUR,
  }),
  bike: doc({ title: "Vélo de ville Btwin", categoryId: "vehicules", subcategoryId: "velos", citySlug: "mohammedia", price: 1_500, condition: "good", sortAt: NOW - 3 * HOUR }),
  fridge: doc({ title: "Frigo Samsung No Frost", categoryId: "maison-jardin", subcategoryId: "electromenager", citySlug: "casablanca", district: "gauthier", price: 2_500, condition: "very_good", sortAt: NOW - 1 * HOUR }),
  sofa: doc({ title: "Canapé en cuir à donner", categoryId: "maison-jardin", subcategoryId: "ameublement", citySlug: "berrechid", isDonation: true, condition: "good", sortAt: NOW - 4 * HOUR }),
  flat: doc({ title: "Appartement 3 chambres Maarif", categoryId: "immobilier", subcategoryId: "location", citySlug: "casablanca", district: "maarif", price: 6_000, a_furnished: true, a_surface: 90, sortAt: NOW - 6 * HOUR }),
  house: doc({ title: "Maison avec jardin", categoryId: "immobilier", subcategoryId: "location", citySlug: "bouskoura", price: 9_000, a_furnished: false, sortAt: NOW - 7 * HOUR }),
  tv: doc({ title: "Télévision Samsung 55 pouces", categoryId: "electronique", subcategoryId: "tv-photo-audio", citySlug: "marrakech", price: 4_000, featuredUntil: NOW + HOUR, sortAt: NOW - 8 * HOUR }),
  expired: doc({ title: "Ancienne mise en avant", categoryId: "vehicules", subcategoryId: "voitures", citySlug: "casablanca", price: 50_000, featuredUntil: NOW - HOUR, sortAt: NOW - 40 * HOUR }),
} satisfies Record<string, SearchDocument>;

const ids = (body: SearchApiResponse) => body.hits.map((hit) => hit.id);
const ok = async (query: string) => {
  const result = await search<SearchApiResponse>(query);
  expect(result.status).toBe(200);
  return result.body;
};

beforeAll(() => resetServerEnv());
beforeEach(async () => {
  resetRateLimiters();
  await serve(Object.values(docs));
});
afterAll(() => setSearchEngineForTests(null));

describe("GET /api/search filters", () => {
  it("answers the newest listings without parameters, never cached", async () => {
    const result = await search<SearchApiResponse>("");
    expect(result.status).toBe(200);
    expect(result.header("cache-control")).toBe("no-store");
    expect(result.body).toMatchObject({ params: {}, sort: "recent", page: 1, totalPages: 1, approximate: false, total: Object.keys(docs).length });
    expect(ids(result.body).slice(0, 3)).toEqual([docs.fridge.id, docs.clio.id, docs.bike.id]);
  });

  it("filters category, subcategory, region and city, and answers canonical parameters", async () => {
    const category = await ok("categorie=immobilier");
    expect(new Set(ids(category))).toEqual(new Set([docs.flat.id, docs.house.id]));
    const sub = await ok("sous-categorie=voitures&inconnu=1&tri=recentes");
    expect(sub.params).toEqual({ category: "vehicules", subcategory: "voitures" });
    expect(new Set(ids(sub))).toEqual(new Set([docs.logan.id, docs.clio.id, docs.peugeot.id, docs.expired.id]));
    expect(new Set(ids(await ok("region=04")))).toEqual(new Set([docs.clio.id]));
    const city = await ok("ville=casablanca&categorie=vehicules");
    expect(city.params).toEqual({ category: "vehicules", city: "casablanca", region: "06" });
    expect(new Set(ids(city))).toEqual(new Set([docs.logan.id, docs.peugeot.id, docs.expired.id]));
  });

  it("filters a district within a city and counts districts there", async () => {
    const result = await ok("ville=casablanca&quartier=Maârif");
    expect(result.params.district).toBe("maarif");
    expect(new Set(ids(result))).toEqual(new Set([docs.logan.id, docs.flat.id]));
    const city = await ok("ville=casablanca");
    expect(city.facets.districts).toEqual({ maarif: 2, gauthier: 1 });
    expect((await ok("region=06")).facets.districts).toBeUndefined();
  });

  it("filters price, seller, shop, donation, photo and condition", async () => {
    expect(new Set(ids(await ok("prix-min=5000&prix-max=80000")))).toEqual(new Set([docs.logan.id, docs.flat.id, docs.house.id, docs.expired.id]));
    expect(ids(await ok("vendeur=pro"))).toEqual([docs.logan.id]);
    expect(ids(await ok(`boutique=${PRO}`))).toEqual([docs.logan.id]);
    expect(ids(await ok(`vendeur-id=${PRO}`))).toEqual([docs.logan.id]);
    expect(ids(await ok("don=1"))).toEqual([docs.sofa.id]);
    expect(ids(await ok("photo=1"))).toEqual([docs.logan.id]);
    expect(new Set(ids(await ok("etat=good,very_good")))).toEqual(new Set([docs.bike.id, docs.fridge.id, docs.sofa.id]));
  });

  it("filters criteria of the chosen subcategory by kind", async () => {
    expect(new Set(ids(await ok("sous-categorie=voitures&f-car-brand=dacia,renault")))).toEqual(new Set([docs.logan.id, docs.clio.id]));
    expect(new Set(ids(await ok("sous-categorie=voitures&f-year-min=2018")))).toEqual(new Set([docs.clio.id, docs.peugeot.id]));
    expect(ids(await ok("sous-categorie=voitures&f-mileage-max=100000"))).toEqual([docs.clio.id]);
    expect(ids(await ok("sous-categorie=location&f-furnished=1"))).toEqual([docs.flat.id]);
    // A criterion of another subcategory is dropped, not an error.
    const foreign = await ok("sous-categorie=velos&f-car-brand=dacia");
    expect(foreign.params).toEqual({ category: "vehicules", subcategory: "velos" });
    expect(ids(foreign)).toEqual([docs.bike.id]);
  });

  it("counts categories and subcategories of the matching listings", async () => {
    const result = await ok("ville=casablanca");
    expect(result.facets.categories).toEqual({ vehicules: 3, "maison-jardin": 1, immobilier: 1 });
    expect(result.facets.subcategories).toEqual({ voitures: 3, electromenager: 1, location: 1 });
  });
});

describe("GET /api/search sorts", () => {
  it("sorts by price both ways, listings without a price last", async () => {
    expect(ids(await ok("categorie=vehicules&tri=prix-croissant"))).toEqual([docs.bike.id, docs.expired.id, docs.logan.id, docs.clio.id, docs.peugeot.id]);
    expect(ids(await ok("categorie=vehicules&tri=prix-decroissant"))).toEqual([docs.peugeot.id, docs.clio.id, docs.logan.id, docs.expired.id, docs.bike.id]);
    const donations = ids(await ok("categorie=maison-jardin&tri=prix-croissant"));
    expect(donations.at(-1)).toBe(docs.sofa.id);
  });

  it("sorts relevance by default with words and recent without", async () => {
    const words = await ok("q=samsung");
    expect(words.sort).toBe("relevance");
    expect(new Set(ids(words))).toEqual(new Set([docs.fridge.id, docs.tv.id]));
    expect((await ok("categorie=vehicules")).sort).toBe("recent");
  });
});

describe("GET /api/search radius around a city", () => {
  it("replaces the city by its centroid radius, across regions", async () => {
    const r20 = await ok("ville=casablanca&rayon=20");
    expect(new Set(ids(r20))).toEqual(new Set([docs.logan.id, docs.peugeot.id, docs.expired.id, docs.fridge.id, docs.flat.id, docs.house.id]));
    const r50 = new Set(ids(await ok("ville=casablanca&rayon=50")));
    expect(r50.has(docs.bike.id) && r50.has(docs.sofa.id) && !r50.has(docs.clio.id)).toBe(true);
    const r100 = new Set(ids(await ok("ville=casablanca&rayon=100")));
    expect(r100.has(docs.clio.id) && !r100.has(docs.tv.id)).toBe(true);
    // A district never narrows a radius search; districts are not counted there.
    const mixed = await ok("ville=casablanca&rayon=20&quartier=maarif");
    expect(mixed.params).toEqual({ city: "casablanca", region: "06", radiusKm: 20 });
    expect(mixed.facets.districts).toBeUndefined();
  });

  it("sorts by distance from the chosen city", async () => {
    const result = await ok("ville=casablanca&rayon=100&tri=distance&categorie=vehicules");
    expect(ids(result)).toEqual([docs.logan.id, docs.peugeot.id, docs.expired.id, docs.bike.id, docs.clio.id]);
    // Without a city the distance sort is dropped.
    expect((await ok("tri=distance")).sort).toBe("recent");
  });
});

describe("GET /api/search words", () => {
  it("finds French listings from Darija in Latin letters and in Arabic script", async () => {
    const latin = await ok("q=tomobil");
    expect(ids(latin)).toContain(docs.logan.id);
    expect(ids(await ok(`q=${encodeURIComponent("سيارة")}`))).toContain(docs.logan.id);
    expect(ids(await ok("q=tlaja"))).toEqual([docs.fridge.id]);
    expect(ids(await ok("q=chi9a"))).toEqual([docs.flat.id]);
  });

  it("falls back to approximate results when every word finds nothing", async () => {
    const result = await ok("q=frigo+samsung+turquoise");
    expect(result.approximate).toBe(true);
    expect(ids(result)).toContain(docs.fridge.id);
    const exact = await ok("q=frigo+samsung");
    expect(exact.approximate).toBe(false);
    expect(ids(exact)).toEqual([docs.fridge.id]);
    expect(await ok("q=turquoise")).toMatchObject({ approximate: false, total: 0, hits: [] });
  });
});

describe("GET /api/search pages and À la Une", () => {
  it("pages by 24 and answers an empty page beyond the last", async () => {
    await serve(Array.from({ length: 30 }, (_, i) => doc({ title: `Objet divers ${i}`, categoryId: "divers", subcategoryId: "autres", citySlug: "settat", price: 10 + i, sortAt: NOW - i * 1000 })));
    const first = await ok("");
    expect([first.hits.length, first.total, first.totalPages, first.page]).toEqual([24, 30, 2, 1]);
    const second = await ok("page=2");
    expect([second.hits.length, second.page, second.params.page]).toEqual([6, 2, 2]);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(30);
    expect((await ok("page=3")).hits).toEqual([]);
    expect((await ok("page=999")).page).toBe(1);
  });

  it("serves running À la Une boosts of the scope on page 1 only", async () => {
    const scoped = await ok("ville=casablanca&categorie=vehicules&prix-max=10");
    expect(scoped.featured.map((card) => [card.id, card.featured])).toEqual([[docs.peugeot.id, true]]);
    expect(scoped.hits).toEqual([]);
    const everywhere = await ok("");
    expect(new Set(everywhere.featured.map((card) => card.id))).toEqual(new Set([docs.peugeot.id, docs.tv.id]));
    expect(everywhere.hits.every((card) => !card.featured)).toBe(true);
    expect((await ok("ville=marrakech")).featured.map((card) => card.id)).toEqual([docs.tv.id]);
    expect((await ok("categorie=vehicules&page=2")).featured).toEqual([]);
  });

  it("returns cards only, never the index-only fields", async () => {
    const [card] = (await ok("vendeur=pro")).hits;
    expect(Object.keys(card ?? {}).sort()).toEqual(
      ["bumped", "citySlug", "featured", "id", "isDonation", "photo", "photoCount", "price", "priceNegotiable", "sellerType", "slugId", "sortAt", "subcategoryId", "title"].sort(),
    );
  });
});

describe("GET /api/search with the engine down", () => {
  it("answers 503 search_unavailable", async () => {
    const down = { kind: "memory", search: async () => Promise.reject(new SearchUnavailableError()) } as unknown as SearchEngine;
    setSearchEngineForTests(down);
    const result = await search<ErrorBody>("q=velo");
    expect([result.status, result.body.error.code]).toEqual([503, "search_unavailable"]);
    expect(result.header("retry-after")).toBe("30");
    expect(result.header("cache-control")).toBe("no-store");
  });
});
