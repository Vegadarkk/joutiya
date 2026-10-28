import { CATEGORIES, type Criterion, type Subcategory } from "@/config/categories";
import { LOCALES } from "@/config/site";
import { CITIES, type City } from "@/config/regions";
import type { ListingDoc, UserDoc } from "@/lib/db/schemas";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { LISTING_ID_ALPHABET, buildSlugId } from "@/lib/listings/ids";

// Load test data set (phase 6, D17): the same listings, ids and URLs on every run, from a seeded
// generator, so the seed (scripts/seed-loadtest.ts, in the worker container), its removal and the
// URL list k6 reads (scripts/load-urls.ts) agree without sharing any state. 5 000 published
// listings are written to Firestore under one seller and indexed; 45 000 more exist in the search
// index only (search load). Every id starts with "zz" (Firestore and index) or "zy" (index only),
// and every title with "[test de charge]", so nothing is mistaken for a member's listing.

export const LOADTEST_LISTINGS = 5_000;
export const LOADTEST_INDEX_ONLY = 45_000;
export const LOADTEST_SELLER_UID = "loadtest-seller";
export const LOADTEST_SELLER_PUBLIC_ID = "zzzzzzzzzz";
export const LOADTEST_TITLE_PREFIX = "[test de charge]";
/** Cities the listings spread over: the largest ones, where real traffic will be. */
export const LOADTEST_CITY_COUNT = 40;

/** Deterministic PRNG (mulberry32), as scripts/bench-search.ts. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Listing id number `n` of a series: "zz" or "zy", then n in base 31 on 6 characters. */
export function loadtestId(series: "zz" | "zy", n: number): string {
  let rest = n;
  let digits = "";
  for (let index = 0; index < 6; index += 1) {
    digits = (LISTING_ID_ALPHABET[rest % LISTING_ID_ALPHABET.length] as string) + digits;
    rest = Math.floor(rest / LISTING_ID_ALPHABET.length);
  }
  return `${series}${digits}`;
}

/** Every id of the data set, Firestore listings first. */
export function loadtestIds(): { firestore: string[]; indexOnly: string[] } {
  return {
    firestore: Array.from({ length: LOADTEST_LISTINGS }, (_, n) => loadtestId("zz", n)),
    indexOnly: Array.from({ length: LOADTEST_INDEX_ONLY }, (_, n) => loadtestId("zy", n)),
  };
}

/** Subcategories open to an individual without moderator review. */
export function loadtestSubcategories(): Subcategory[] {
  return CATEGORIES.flatMap((category) => category.subcategories).filter((sub) => !sub.proOnly && !sub.adultsOnly);
}

export function loadtestCities(): City[] {
  return [...CITIES].sort((a, b) => b.population - a.population || a.slug.localeCompare(b.slug)).slice(0, LOADTEST_CITY_COUNT);
}

/** A valid value for each required criterion (and a few optional ones), so the filters have data. */
function attributesOf(sub: Subcategory, random: () => number): ListingDoc["attributes"] {
  const attributes: Record<string, unknown> = {};
  for (const criterion of sub.criteria as readonly Criterion[]) {
    if (!criterion.required && random() < 0.5) continue;
    const options = criterion.options ?? [];
    if (criterion.type === "select" && options.length > 0) attributes[criterion.id] = options[Math.floor(random() * options.length)];
    else if (criterion.type === "multiselect" && options.length > 0) attributes[criterion.id] = [options[Math.floor(random() * options.length)]];
    else if (criterion.type === "number") {
      const min = criterion.min ?? 0;
      const max = Math.min(criterion.max ?? min + 100, min + 1_000);
      attributes[criterion.id] = min + Math.floor(random() * (max - min + 1));
    } else if (criterion.type === "boolean") attributes[criterion.id] = random() < 0.5;
    else if (criterion.type === "text" && criterion.required) attributes[criterion.id] = "Test";
  }
  return attributes as ListingDoc["attributes"];
}

const WORDS = ["vélo", "voiture", "appartement", "téléphone", "canapé", "table", "ordinateur", "veste", "chaussures", "lampe", "tapis", "frigo", "console", "moto", "jardin"];

/** Words the search scenario looks for: the ones the titles use. */
export const LOADTEST_QUERY_WORDS: readonly string[] = WORDS;

/** The listing number `n` of a series, as the repository reads it. */
export function loadtestListing(series: "zz" | "zy", n: number, now: Date): ListingRecord {
  const random = prng((series === "zz" ? 0x5eed : 0xbeef) + n);
  const subs = loadtestSubcategories();
  const cities = loadtestCities();
  const sub = subs[Math.floor(random() * subs.length)] as Subcategory;
  const city = cities[Math.floor(random() * cities.length)] as City;
  const word = WORDS[Math.floor(random() * WORDS.length)] as string;
  const id = loadtestId(series, n);
  const title = `${LOADTEST_TITLE_PREFIX} ${word} ${n}`;
  const at = new Date(now.getTime() - Math.floor(random() * 30 * 86_400_000));
  return {
    id,
    ownerUid: LOADTEST_SELLER_UID,
    sellerType: "individual",
    sellerName: "Test de charge",
    sellerPublicId: LOADTEST_SELLER_PUBLIC_ID,
    status: "published",
    slugId: buildSlugId({ id, title, city: city.nameFr, categoryId: sub.categoryId }),
    title,
    description: `Annonce fictive du test de charge de Joutiya (${word}, ${city.nameFr}). Elle est supprimée après le test.`,
    categoryId: sub.categoryId,
    subcategoryId: sub.id,
    attributes: attributesOf(sub, random),
    ...(sub.condition ? { condition: "good" as const } : {}),
    price: 100 + Math.floor(random() * 50_000),
    priceNegotiable: random() < 0.5,
    isDonation: false,
    location: { regionCode: city.regionCode, citySlug: city.slug, geo: { lat: city.lat, lng: city.lng } },
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: at,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: false,
    publishedAt: at,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    legalHold: [],
    createdAt: at,
    updatedAt: at,
    version: 1,
  } as ListingRecord;
}

/** The seller of every load test listing (no Firebase Auth account: nobody signs in as it). */
export function loadtestSeller(now: Date): UserDoc {
  return {
    publicId: LOADTEST_SELLER_PUBLIC_ID,
    displayName: "Test de charge",
    type: "individual",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: LOADTEST_LISTINGS, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: now,
    updatedAt: now,
  } as UserDoc;
}

/**
 * Page paths of the SSR scenario, each never rendered before the run (ISR misses): the listing
 * pages of the Firestore set in every locale, then the category x city and subcategory x city
 * landing pages, shuffled the same way every time.
 */
export function loadtestPagePaths(now: Date = new Date(0)): string[] {
  const paths: string[] = [];
  for (let n = 0; n < LOADTEST_LISTINGS; n += 1) {
    const { slugId } = loadtestListing("zz", n, now);
    for (const locale of LOCALES) paths.push(`/${locale}/annonce/${slugId}`);
  }
  for (const city of loadtestCities()) {
    for (const category of CATEGORIES) {
      for (const locale of LOCALES) paths.push(`/${locale}/c/${category.id}/${city.slug}`);
      for (const sub of category.subcategories) if (!sub.adultsOnly) for (const locale of LOCALES) paths.push(`/${locale}/c/${category.id}/${sub.id}/${city.slug}`);
    }
  }
  const random = prng(0xc0ffee);
  for (let index = paths.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [paths[index], paths[other]] = [paths[other] as string, paths[index] as string];
  }
  return paths;
}

/** Query strings of the search scenario: words, cities, categories and sorts of the data set. */
export function loadtestSearchQueries(count: number): string[] {
  const random = prng(0x5ea7c4);
  const cities = loadtestCities();
  const sorts = ["", "prix-croissant", "prix-decroissant"];
  return Array.from({ length: count }, () => {
    const query = new URLSearchParams({ q: WORDS[Math.floor(random() * WORDS.length)] as string });
    if (random() < 0.5) query.set("ville", (cities[Math.floor(random() * cities.length)] as City).slug);
    if (random() < 0.3) query.set("categorie", (CATEGORIES[Math.floor(random() * CATEGORIES.length)] as { id: string }).id);
    const sort = sorts[Math.floor(random() * sorts.length)] as string;
    if (sort) query.set("tri", sort);
    return query.toString();
  });
}
