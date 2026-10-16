import { LEXICON_CITIES, LEXICON_ENTRIES } from "./darija-data";

// Darija search lexicon (phase 4, design D4/D5). Client-safe data.
// One entry = the spellings of one concept a buyer may type: French, Darija in Latin letters with
// digits (arabizi: 3 = ع, 7 = ح, 9 = ق, 5 = خ...) and Arabic script. One city = its French and Arabic
// names with their usual variants. src/lib/search/settings.ts turns each entry and each city into one
// group of mutual Meilisearch synonyms (the memory engine reads the same map); src/lib/search/
// normalize.ts maps an unknown arabizi spelling or an Arabic phrase Meilisearch misses onto the
// entry's canonical spelling.
//
// Sources (research of 16 Oct 2026): hand-written entries; spellings checked against Wiktionary and
// Wikipedia (CC BY-SA 4.0, facts only, no text copied) and marketplace vocabulary observed on
// Moroccan classifieds sites (single words, no text copied). The Darija Open Dataset (CC BY-NC 4.0)
// was used only to verify spellings: nothing copied from it.
//
// Rules for edits (darija-data.ts): attested spellings only; a spelling belongs to one entry; never
// "auto" (auto-école, boîte auto); "kra" means rent; at most 49 spellings per group and 3 words per
// spelling (Meilisearch synonym limits); a city omits spellings that are common words ("jdida" = new).

export interface LexiconEntry {
  /** Main spelling (French, accents allowed): the target of query rewrites. */
  canonical: string;
  /** Main Arabic-script spelling ("" when none). */
  ar: string;
  variants: readonly string[];
  category: string;
  note?: string;
}

export interface CityLexicon {
  /** src/config/regions.ts slug (tests check it exists). */
  slug: string;
  name: string;
  ar: string;
  variants: readonly string[];
}

export const DARIJA_LEXICON: readonly LexiconEntry[] = LEXICON_ENTRIES;
export const CITY_LEXICON: readonly CityLexicon[] = LEXICON_CITIES;

/**
 * Spellings kept out of the synonym groups although the entry lists them (query text still matches
 * documents that contain them). Besides this list, settings.ts drops any single-word spelling that
 * is a word of a city name ("dar", "دار" of maison; "جديدة" of neuf, i.e. El Jadida once the article
 * is split off): as synonyms they would pull every listing of Casablanca or El Jadida.
 */
export const SYNONYM_GUARDED: ReadonlyMap<string, string> = new Map([
  // Folds to "meuble" (furniture): every furniture query would expand to "furnished".
  ["meublé", "accent-folds onto meuble (furniture)"],
]);

/** Every spelling of an entry: canonical, Arabic, variants (empty ones dropped). */
export function entrySpellings(entry: LexiconEntry): string[] {
  return [entry.canonical, entry.ar, ...entry.variants].filter((spelling) => spelling.trim() !== "");
}

/** Every spelling of a city: French name, Arabic name, variants. */
export function citySpellings(city: CityLexicon): string[] {
  return [city.name, city.ar, ...city.variants].filter((spelling) => spelling.trim() !== "");
}
