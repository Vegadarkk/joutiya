import { CRITERIA } from "@/config/categories";
import { CITIES } from "@/config/regions";
import { CITY_LEXICON, DARIJA_LEXICON, SYNONYM_GUARDED, citySpellings, entrySpellings } from "@/config/search/darija";
import { foldArabicWord, foldToken } from "./normalize";
import { SEARCH_MAX_TOTAL_HITS } from "./params";
import { attributeField } from "./types";

// Index settings of the listings index (design D4), applied by `ensureReady` (worker start,
// scripts/search-setup.ts) when they differ from the live ones. The memory engine reads the same
// lists so both engines accept and refuse the same queries. Client-safe, no server import.

/** Ordered: an earlier attribute ranks higher ("attributeRank"). */
export const SEARCHABLE_ATTRIBUTES = ["title", "categoryText", "attrsText", "placeText", "description"] as const;

/** Equality filters (`=`, `IN`, `EXISTS`) and facets. */
const EQUALITY_BASE = [
  "id",
  "categoryId",
  "subcategoryId",
  "regionCode",
  "citySlug",
  "district",
  "sellerType",
  "sellerPublicId",
  "isDonation",
  "hasPhoto",
  "soldOut",
  "condition",
  "sitemapShard",
  "rentUnavailableDays",
] as const;

/** Numeric fields that also take `<`, `<=`, `>`, `>=`. */
const COMPARISON_BASE = ["price", "sortAt", "featuredUntil", "rentFreshUntil"] as const;

const criteria = Object.values(CRITERIA);
/** `a_*` fields of select, multiselect and boolean criteria (free-text criteria stay searchable only). */
export const EQUALITY_FILTERS: readonly string[] = [
  ...EQUALITY_BASE,
  ...criteria.filter((c) => c.type === "select" || c.type === "multiselect" || c.type === "boolean").map((c) => attributeField(c.id)),
];
/** Number criteria (`a_year`, `a_mileage`...) compare like prices. */
export const COMPARISON_FILTERS: readonly string[] = [...COMPARISON_BASE, ...criteria.filter((c) => c.type === "number").map((c) => attributeField(c.id))];
export const GEO_FIELD = "_geo";

export type FilterKind = "equality" | "comparison" | "geo";
const FILTER_KINDS = new Map<string, FilterKind>([
  ...EQUALITY_FILTERS.map((field) => [field, "equality"] as const),
  ...COMPARISON_FILTERS.map((field) => [field, "comparison"] as const),
  [GEO_FIELD, "geo"],
]);

/** Kind of a filterable field, undefined when the field cannot be filtered (or faceted). */
export function filterKind(field: string): FilterKind | undefined {
  return FILTER_KINDS.get(field);
}

export const SORTABLE_ATTRIBUTES = ["sortAt", "price", "_geo"] as const;

/**
 * D4: "sort" right after "words", so a date or price sort orders the matching listings and relevance
 * only breaks ties; `sortAt:desc` last (newest first for equal relevance and for browsing).
 * `attributeRank` + `wordPosition` = the legacy `attribute` rule (Meilisearch >= 1.36 split it).
 */
export const RANKING_RULES = ["words", "sort", "typo", "proximity", "attributeRank", "wordPosition", "exactness", "sortAt:desc"] as const;

/**
 * Meilisearch splits the Arabic article (these five spellings) off words as its own token: as stop
 * words they no longer match every Arabic text ("السيارة" finds "سيارة", "ال" alone finds nothing).
 */
export const STOP_WORDS = ["ال", "أل", "إل", "آل", "ٱل"] as const;

/** Facet values returned per facet: every city (CITIES has 100) and every subcategory. */
export const MAX_VALUES_PER_FACET = 200;

/** Meilisearch limits: synonyms per term, words per synonym term. */
export const MAX_SYNONYMS_PER_TERM = 50;
export const MAX_SYNONYM_WORDS = 3;

/** Meilisearch-like fold of a term: accents, case, Arabic letter variants; hyphens and apostrophes split words. */
export function synonymKey(term: string): string {
  return term
    .split(/[\s\-'’`]+/)
    .filter(Boolean)
    .map((word) => foldArabicWord(foldToken(word), false))
    .join(" ");
}

/** Word as the engine indexes it: folded, Arabic article split off. */
function indexedWord(word: string): string {
  const folded = foldArabicWord(foldToken(word)).replace(/[أإآٱ]/g, "ا");
  return folded.length > 2 && folded.startsWith("ال") ? folded.slice(2) : folded;
}

let placeWords: Set<string> | undefined;
/** Every word of every city name and city variant (fr, ar). */
function cityWords(): Set<string> {
  placeWords ??= new Set(
    [...CITIES.flatMap((city) => [city.nameFr, city.nameAr]), ...CITY_LEXICON.flatMap(citySpellings)].flatMap((name) => name.split(/[\s\-'’`]+/).filter(Boolean).map(indexedWord)),
  );
  return placeWords;
}

/** Meilisearch folds ڭ ڤ پ to nothing else: list the ك ف ب spelling too. */
function withRegionalDuplicates(spellings: readonly string[]): string[] {
  return spellings.flatMap((spelling) => {
    const plain = spelling.replace(/[ڭݣگ]/g, "ك").replace(/ڤ/g, "ف").replace(/پ/g, "ب");
    return plain === spelling ? [spelling] : [spelling, plain];
  });
}

/** One spelling per folded form, lower case, single spaces, at most MAX_SYNONYM_WORDS words. */
function spellings(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of withRegionalDuplicates(terms)) {
    const spelling = term.toLowerCase().replace(/\s+/g, " ").trim();
    const key = synonymKey(spelling);
    if (!key || seen.has(key) || key.split(" ").length > MAX_SYNONYM_WORDS) continue;
    seen.add(key);
    out.push(spelling);
  }
  return out;
}

/** True when an entry spelling must stay out of the synonyms (guard list, or a word of a city name). */
export function isGuardedSpelling(spelling: string): boolean {
  if (SYNONYM_GUARDED.has(spelling)) return true;
  const words = spelling.split(/[\s\-'’`]+/).filter(Boolean);
  return words.length === 1 && cityWords().has(indexedWord(words[0] ?? ""));
}

/** Groups of equivalent spellings: one per lexicon entry (guards applied), one per city. */
export function synonymGroups(): string[][] {
  const groups = [
    ...DARIJA_LEXICON.map((entry) => spellings(entrySpellings(entry).filter((spelling) => !isGuardedSpelling(spelling)))),
    ...CITY_LEXICON.map((city) => spellings(citySpellings(city))),
  ];
  return groups.filter((group) => group.length > 1);
}

/**
 * Mutual synonyms (Meilisearch does not make them transitive): every spelling of a group lists all
 * the others. A spelling in two groups gets the union (the lexicon avoids it; tests check).
 */
export function buildSynonyms(groups: readonly (readonly string[])[]): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const term of group) {
      const others = map.get(term) ?? new Set<string>();
      for (const other of group) if (other !== term) others.add(other);
      map.set(term, others);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [term, others] of [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[term] = [...others].slice(0, MAX_SYNONYMS_PER_TERM);
  }
  return out;
}

export const SEARCH_SYNONYMS: Readonly<Record<string, readonly string[]>> = buildSynonyms(synonymGroups());

type FilterRule = string | { attributePatterns: string[]; features: { facetSearch: boolean; filter: { equality: boolean; comparison: boolean } } };

/** Index settings sent with `PATCH /indexes/{uid}/settings` (shapes verified on Meilisearch 1.55.0). */
export interface IndexSettings {
  displayedAttributes: string[];
  searchableAttributes: string[];
  filterableAttributes: FilterRule[];
  sortableAttributes: string[];
  rankingRules: string[];
  stopWords: string[];
  synonyms: Record<string, string[]>;
  typoTolerance: {
    enabled: boolean;
    minWordSizeForTypos: { oneTypo: number; twoTypos: number };
    disableOnWords: string[];
    disableOnAttributes: string[];
    disableOnNumbers: boolean;
  };
  faceting: { maxValuesPerFacet: number; sortFacetValuesBy: Record<string, "alpha" | "count"> };
  pagination: { maxTotalHits: number };
  localizedAttributes: { attributePatterns: string[]; locales: string[] }[];
  searchCutoffMs: number;
  facetSearch: boolean;
  proximityPrecision: "byWord" | "byAttribute";
}

export const SEARCH_SETTINGS: Readonly<IndexSettings> = {
  // Every field: the API whitelists with attributesToRetrieve (CARD_FIELDS); nothing private is indexed.
  displayedAttributes: ["*"],
  searchableAttributes: [...SEARCHABLE_ATTRIBUTES],
  // Granular rules: no facet search anywhere, comparisons only on numbers (smaller index).
  filterableAttributes: [
    { attributePatterns: [...EQUALITY_FILTERS], features: { facetSearch: false, filter: { equality: true, comparison: false } } },
    { attributePatterns: [...COMPARISON_FILTERS], features: { facetSearch: false, filter: { equality: true, comparison: true } } },
    GEO_FIELD,
  ],
  sortableAttributes: [...SORTABLE_ATTRIBUTES],
  rankingRules: [...RANKING_RULES],
  stopWords: [...STOP_WORDS],
  synonyms: Object.fromEntries(Object.entries(SEARCH_SYNONYMS).map(([term, others]) => [term, [...others]])),
  // Default sizes; no typo on numbers (prices, years, "golf 7", "206").
  typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 }, disableOnWords: [], disableOnAttributes: [], disableOnNumbers: true },
  faceting: { maxValuesPerFacet: MAX_VALUES_PER_FACET, sortFacetValuesBy: { "*": "count" } },
  // 50 pages x 24 (§6). Page mode still reports the exhaustive totalHits.
  pagination: { maxTotalHits: SEARCH_MAX_TOTAL_HITS },
  // §5: Tarifit in Latin letters follows French; arabizi is Latin script either way.
  localizedAttributes: [{ attributePatterns: [...SEARCHABLE_ATTRIBUTES], locales: ["fra", "ara"] }],
  // Return what is computed after 500 ms instead of 1.5 s (Meilisearch advice: not lower).
  searchCutoffMs: 500,
  facetSearch: false,
  proximityPrecision: "byWord",
};

/** Arrays whose order carries no meaning (Meilisearch returns some of them sorted). */
const UNORDERED = new Set([
  "sortableAttributes",
  "stopWords",
  "typoTolerance.disableOnWords",
  "typoTolerance.disableOnAttributes",
  "filterableAttributes.attributePatterns",
  "localizedAttributes.attributePatterns",
  "localizedAttributes.locales",
]);

function canonical(value: unknown, path: string): unknown {
  // Meilisearch may return strings decomposed ("آ" as alef + madda): compare composed forms.
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, path));
    if (UNORDERED.has(path) || path.startsWith("synonyms.")) return items.map((item) => JSON.stringify(item)).sort();
    return items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key.normalize("NFC"), canonical(item, `${path}.${key}`)]));
  }
  return value;
}

/**
 * Names of the top-level settings whose live value differs from `desired` (empty = up to date).
 * Objects are compared on the keys `desired` sets, so defaults Meilisearch adds do not count.
 */
export function settingsDiff(current: unknown, desired: Readonly<IndexSettings> = SEARCH_SETTINGS): (keyof IndexSettings)[] {
  const live = current && typeof current === "object" ? (current as Record<string, unknown>) : {};
  const differs = (want: unknown, have: unknown, path: string): boolean => {
    if (want && typeof want === "object" && !Array.isArray(want)) {
      // Synonyms are a whole map: an extra live key is a difference too.
      if (path === "synonyms") return JSON.stringify(canonical(want, path)) !== JSON.stringify(canonical(have, path));
      if (!have || typeof have !== "object" || Array.isArray(have)) return true;
      return Object.entries(want as Record<string, unknown>).some(([key, value]) => differs(value, (have as Record<string, unknown>)[key], `${path}.${key}`));
    }
    return JSON.stringify(canonical(want, path)) !== JSON.stringify(canonical(have, path));
  };
  return (Object.keys(desired) as (keyof IndexSettings)[]).filter((key) => differs(desired[key], live[key], key));
}
