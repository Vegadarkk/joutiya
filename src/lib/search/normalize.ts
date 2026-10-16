import { CITY_LEXICON, DARIJA_LEXICON, citySpellings, entrySpellings } from "@/config/search/darija";
import { SEARCH_Q_MAX } from "./params";

// Query normalisation (design D5), applied to `q` before any engine call. Meilisearch already folds
// case, accents and most Arabic letter variants; this step only does what it cannot:
// 1. Arabic-Indic (٠-٩) and Persian (۰-۹) digits -> ASCII: Meilisearch keeps them apart ("٢٠١٩" never
//    finds "2019"). Index text needs the same folding: `foldDigits` (document builder).
// 2. Search operators neutralised: double quotes (phrase search) and a leading "-" (exclusion) would
//    silently change the results of a pasted title.
// 3. Arabic phrases of the lexicon (2-3 words, e.g. "الدار البيضاء") -> the entry's canonical spelling,
//    longest phrase first: Meilisearch 1.55.0 does not trigger some multi-word Arabic synonym keys;
//    the canonical spelling's synonyms then bring the phrase back.
// 4. Arabizi digit guard (research rule): per token, class N (no arabizi digit, or not plain a-z0-9:
//    untouched), P (protected: units, models, "b2b": untouched) or A (arabizi). Digits only build a
//    lookup key (3 -> a, 7 -> h, 9 -> q...) and a vowel-insensitive skeleton; a class A token unknown
//    to the lexicon whose key, else whose skeleton, belongs to exactly one entry is replaced by that
//    entry's canonical spelling ("chi9a" -> "appartement"). Nothing else is rewritten: "iphone 13",
//    "golf 7", "clio 4", "206", prices, years and phone numbers reach the engine as typed.
// No generic Latin -> Arabic transliteration (lossy).

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits -> ASCII digits. */
export function foldDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => String((digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)) % 10));
}

// ---- Arabizi digit guard (port of the research reference implementation, with its tests).

const UNITS = "k|km|kg|g|gb|go|mo|mb|tb|to|m|m2|cm|mm|l|cl|ml|w|kw|v|hz|mp|mah|cv|ch|dh|mad|h|an|ans|mois|e|er|ere|eme|d|p|pc|pcs|piece|pieces|place|places|porte|portes|chambre|chambres|sdb|salon|salons|etage|etages|pouce|pouces|po";
const MODELS = "mp|iphone|ipad|galaxy|redmi|note|poco|pixel|mate|nova|reno|tab|ps|xbox|switch|golf|clio|megane|polo|passat|tiguan|serie|classe|rs|gt|gts|gtx|rtx|rx|ryzen|core|macbook|id|ds|cx|mx|sl|slk|clk|gla|glb|glc|gle|gls|cla|cls";
const SUFFIX = "e|u|s|t|x|m|xl|fe|gt|gti|gtd|ti|pro|max|plus|ultra|lite|mini|se|xs|xr|tdi|hdi|dci|cdi|vti|tsi|tfsi|l|i|d|k";
const GUARD = {
  /** 5000dh 128go 2eme 7places */
  unit: new RegExp(`^\\d+(?:${UNITS})$`),
  /** iphone13 golf7 a52 s23u ps5 f3 x5 (a single letter before the digits counts as a model). */
  model: new RegExp(`^(?:[a-z]|${MODELS})\\d{1,4}(?:${SUFFIX})?$`),
  /** Alphanumeric words that are not arabizi. */
  stop: /^(?:b2b|b2c|h2o|k7|o2)$/,
};
/** 4 has no stable value and 0, 1 are never letters. */
const KEY_MAP: Readonly<Record<string, string>> = { "2": "", "3": "a", "5": "kh", "6": "t", "7": "h", "8": "h", "9": "q" };

export type TokenClass = "N" | "P" | "A";

/** Latin fold of one token: accents and case removed, apostrophes dropped. */
export function foldToken(raw: string): string {
  return raw.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’`]/g, "");
}

/** Class of a query token and its lookup key (only class A keys differ from the folded token). */
export function classifyToken(raw: string): { cls: TokenClass; key: string } {
  const token = foldToken(raw);
  if (!/^[a-z0-9]+$/.test(token)) return { cls: "N", key: token };
  if (!/[a-z]/.test(token)) return { cls: "N", key: token };
  if (!/[235-9]/.test(token)) return { cls: "N", key: token };
  if (GUARD.unit.test(token) || GUARD.model.test(token) || GUARD.stop.test(token)) return { cls: "P", key: token };
  return { cls: "A", key: token.replace(/[235-9]/g, (digit) => KEY_MAP[digit] ?? "") };
}

// ---- Lexicon lookups.

/** Skeleton digits: like the key map, but ayn stays a consonant ("3ayla" and "3ila" share "3l"). */
const SKELETON_MAP: Readonly<Record<string, string>> = { "2": "", "3": "3", "5": "kh", "6": "t", "7": "h", "8": "h", "9": "q" };
/** Shortest skeleton used for a rewrite. */
const MIN_SKELETON = 2;

/**
 * Vowel-insensitive key of an arabizi spelling: digits mapped, "sh" = "ch", vowels (a e i o u y)
 * dropped, repeated letters collapsed: "chi9a", "cha9a", "ch9a" -> "chq"; "mo7ami", "m7ami" -> "mhm".
 */
export function arabiziSkeleton(token: string): string {
  return foldToken(token)
    .replace(/[235-9]/g, (digit) => SKELETON_MAP[digit] ?? "")
    .replace(/sh/g, "ch")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/**
 * Arabic-script fold matching Meilisearch's (hamza carriers, alef maqsura, ta marbuta, marks, tatweel);
 * `regional` also folds ڭ ݣ گ ڤ پ, which Meilisearch keeps (lexicon lookups treat them as ك ف ب).
 */
export function foldArabicWord(word: string, regional = true): string {
  const folded = word.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ـ/g, "").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
  return regional ? folded.replace(/[ڭݣگ]/g, "ك").replace(/ڤ/g, "ف").replace(/پ/g, "ب") : folded;
}

const ARABIC = /[؀-ۿ]/;

interface Tables {
  /** Folded single-token Latin spellings known to the lexicon (synonyms already cover them). */
  known: Set<string>;
  /** Lookup key -> canonical spelling (keys shared by two entries are dropped). */
  keys: Map<string, string>;
  /** Skeleton of a verified class A spelling -> canonical spelling (shared skeletons are dropped). */
  skeletons: Map<string, string>;
  /** Folded Arabic phrase of 2-3 words -> canonical spelling. */
  phrases: Map<string, string>;
  /** Keys and phrases shared by two groups (the data tests require none). */
  ambiguous: string[];
  /** Skeletons shared by two groups (no rewrite for them). */
  ambiguousSkeletons: string[];
}

let tables: Tables | undefined;

function lexiconTables(): Tables {
  if (tables) return tables;
  const known = new Set<string>();
  const keyOwners = new Map<string, Set<string>>();
  const skeletonOwners = new Map<string, Set<string>>();
  const phraseOwners = new Map<string, Set<string>>();
  const claim = (owners: Map<string, Set<string>>, key: string, canonical: string) => owners.set(key, (owners.get(key) ?? new Set<string>()).add(canonical));
  const groups = [
    ...DARIJA_LEXICON.map((entry) => ({ canonical: entry.canonical, spellings: entrySpellings(entry) })),
    ...CITY_LEXICON.map((city) => ({ canonical: city.name, spellings: citySpellings(city) })),
  ];
  for (const { canonical, spellings } of groups) {
    for (const spelling of spellings) {
      const words = spelling.trim().split(/[\s\-]+/).filter(Boolean);
      if (words.length === 1) {
        const { cls, key } = classifyToken(words[0] ?? "");
        if (!/^[a-z0-9]+$/.test(key) || cls === "P") continue;
        known.add(foldToken(words[0] ?? ""));
        claim(keyOwners, key, canonical);
        const skeleton = arabiziSkeleton(words[0] ?? "");
        if (cls === "A" && skeleton.length >= MIN_SKELETON) claim(skeletonOwners, skeleton, canonical);
      } else if (words.length <= 3 && words.every((word) => ARABIC.test(word))) {
        claim(phraseOwners, words.map((word) => foldArabicWord(word)).join(" "), canonical);
      }
    }
  }
  const unique = (owners: Map<string, Set<string>>, shared: string[]) => {
    const map = new Map<string, string>();
    for (const [key, set] of owners) {
      const [only] = set;
      if (set.size === 1 && only !== undefined) map.set(key, only);
      else shared.push(key);
    }
    return map;
  };
  const ambiguous: string[] = [];
  const ambiguousSkeletons: string[] = [];
  tables = {
    known,
    keys: unique(keyOwners, ambiguous),
    skeletons: unique(skeletonOwners, ambiguousSkeletons),
    phrases: unique(phraseOwners, ambiguous),
    ambiguous,
    ambiguousSkeletons: ambiguousSkeletons.sort(),
  };
  return tables;
}

/** Lookup keys and phrases claimed by two lexicon groups (dropped at runtime; data tests require none). */
export function ambiguousLexiconKeys(): string[] {
  return lexiconTables().ambiguous;
}

/** Skeletons shared by verified arabizi spellings of two groups: never used for a rewrite. */
export function ambiguousSkeletons(): string[] {
  return lexiconTables().ambiguousSkeletons;
}

/**
 * Canonical spelling for an unknown class A token, else undefined: first the exact lookup key
 * (digits mapped), then the vowel-insensitive skeleton of the verified arabizi spellings
 * ("chi9a", "cha9a" -> the "ch9a" of appartement).
 */
export function arabiziCanonical(token: string): string | undefined {
  const { cls, key } = classifyToken(token);
  if (cls !== "A") return undefined;
  const { known, keys, skeletons } = lexiconTables();
  if (known.has(foldToken(token))) return undefined;
  const skeleton = arabiziSkeleton(token);
  return keys.get(key) ?? (skeleton.length >= MIN_SKELETON ? skeletons.get(skeleton) : undefined);
}

/** Replaces lexicon Arabic phrases (longest first, 3 then 2 words) by their canonical spelling. */
function replacePhrases(words: string[]): string[] {
  const { phrases } = lexiconTables();
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let replaced = false;
    for (let size = Math.min(3, words.length - i); size >= 2 && !replaced; size -= 1) {
      const window = words.slice(i, i + size);
      if (!window.every((word) => ARABIC.test(word))) continue;
      const canonical = phrases.get(window.map((word) => foldArabicWord(word)).join(" "));
      if (canonical) {
        out.push(canonical);
        i += size;
        replaced = true;
      }
    }
    if (!replaced) {
      out.push(words[i] ?? "");
      i += 1;
    }
  }
  return out;
}

/** Normalised query text for the engine ("" = browse). */
export function normalizeQuery(q: string): string {
  const words = foldDigits(q)
    .replace(/["“”„«»]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[-‐-―]+/, ""))
    .filter(Boolean);
  return replacePhrases(words)
    .map((word) => arabiziCanonical(word) ?? word)
    .join(" ")
    .slice(0, SEARCH_Q_MAX)
    .trim();
}
