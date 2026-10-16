import { DARIJA_LEXICON } from "@/config/search/darija";
import { SEARCH_Q_MAX } from "./params";

// Query normalisation (design D5), applied to `q` before any engine call. Meilisearch already
// folds case, accents and Arabic letter variants; what it does not do is done here:
// - Arabic-Indic (٠-٩) and Persian (۰-۹) digits -> ASCII (Meilisearch keeps them apart: "٢٠١٩"
//   never matches "2019"). Index text needs the same folding: `foldDigits` (document builder).
// - Search operators are neutralised: double quotes (phrase search) and a leading "-" (exclusion)
//   would silently change the results of a pasted title.
// - Arabizi variants: a token in Latin letters with arabizi digits (3, 7, 9...) whose letter
//   skeleton equals the skeleton of exactly one lexicon group is replaced by that group's
//   canonical spelling, which the synonyms then expand ("shi9a", "chii9a" -> "chi9a").
//   Never touched: numbers ("206", "2016"), model names ("golf 7", "iphone 13", "a3", "ds7",
//   "rs3": a token with fewer than 3 letters, two adjacent digits or a digit 0, 1, 4 or 6).
// No generic Latin -> Arabic transliteration (lossy).

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits -> ASCII digits. */
export function foldDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => String((digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)) % 10));
}

const ARABIZI_DIGIT: Record<string, string> = { "2": "", "3": "", "5": "kh", "7": "h", "8": "gh", "9": "q" };

/**
 * Consonant skeleton of a Latin or arabizi spelling: arabizi digits as letters, "sh" = "ch",
 * vowels dropped, doubled letters collapsed ("chi9a", "shiqa", "ch9a" -> "chq").
 */
export function arabiziSkeleton(word: string): string {
  return word
    .toLowerCase()
    .replace(/[235789]/g, (digit) => ARABIZI_DIGIT[digit] ?? "")
    .replace(/sh/g, "ch")
    .replace(/[^a-z]/g, "")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** Shortest skeleton used for a rewrite: shorter ones collide with unrelated words. */
const MIN_SKELETON = 3;

let skeletons: Map<string, string> | undefined;

/** Skeleton -> canonical spelling, only for skeletons owned by a single lexicon group. */
function skeletonIndex(): Map<string, string> {
  if (skeletons) return skeletons;
  const owners = new Map<string, Set<string>>();
  const canonicalOf = new Map<string, string>();
  for (const group of DARIJA_LEXICON) {
    const canonical = group.latin[0];
    if (!canonical) continue;
    canonicalOf.set(group.id, canonical.toLowerCase());
    for (const spelling of [...group.latin, ...group.fr]) {
      if (spelling.includes(" ")) continue;
      const skeleton = arabiziSkeleton(spelling);
      if (skeleton.length < MIN_SKELETON) continue;
      const set = owners.get(skeleton) ?? new Set<string>();
      set.add(group.id);
      owners.set(skeleton, set);
    }
  }
  skeletons = new Map();
  for (const [skeleton, groups] of owners) {
    const [only] = groups;
    if (groups.size === 1 && only) skeletons.set(skeleton, canonicalOf.get(only) ?? "");
  }
  return skeletons;
}

/** Latin letters with at least one arabizi digit, 3+ letters, no adjacent digits, no 0/1/4/6. */
function isArabiziCandidate(token: string): boolean {
  if (!/^[a-z235789]+$/.test(token) || !/[235789]/.test(token) || /\d\d/.test(token)) return false;
  return (token.match(/[a-z]/g)?.length ?? 0) >= 3;
}

function canonicalToken(token: string): string {
  const lower = token.toLowerCase();
  if (!isArabiziCandidate(lower)) return token;
  const skeleton = arabiziSkeleton(lower);
  if (skeleton.length < MIN_SKELETON) return token;
  return skeletonIndex().get(skeleton) ?? token;
}

/** Normalised query text for the engine ("" = browse). */
export function normalizeQuery(q: string): string {
  const words = foldDigits(q)
    .replace(/["“”„]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[-‐-―]+/, ""))
    .filter(Boolean)
    .map(canonicalToken);
  return words.join(" ").slice(0, SEARCH_Q_MAX).trim().toLowerCase();
}
