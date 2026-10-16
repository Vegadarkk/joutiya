// Text normalisation shared by search (city picker) and moderation (keyword matching, D8).
// Client-safe, no dependencies. Latin: NFKD, lower case, diacritics removed, apostrophes and
// punctuation collapsed to spaces. Arabic: tashkeel and tatweel removed, alef / ya / ta marbuta
// variants folded, Arabic-Indic digits mapped to ASCII. Apostrophes are dropped (M'diq -> mdiq).

const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const LATIN_MARKS = /[̀-ͯ]/g;
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const APOSTROPHES = /['’`´]/g;
const SEPARATORS = /[\s\-_.,;:!?()[\]{}"«»/\\|+*&#@~^<>=]+/g;

const ARABIC_FOLD: Record<string, string> = {
  "آ": "ا", // آ
  "أ": "ا", // أ
  "إ": "ا", // إ
  "ٱ": "ا", // ٱ
  "ى": "ي", // ى -> ي
  "ة": "ه", // ة -> ه
  "ؤ": "و", // ؤ -> و
  "ئ": "ي", // ئ -> ي
  "ک": "ك", // ک -> ك
  "ی": "ي", // ی -> ي
  "گ": "ك", // گ -> ك (Moroccan Gaf, rare)
};

function foldArabic(text: string): string {
  let out = "";
  for (const ch of text) out += ARABIC_FOLD[ch] ?? ch;
  return out;
}

/** Lower-cased, accent-insensitive form with single spaces, for comparisons and searches. */
export function normalizeText(input: string): string {
  const folded = foldArabic(input)
    .replace(APOSTROPHES, "")
    .normalize("NFKD")
    .replace(LATIN_MARKS, "")
    .replace(ARABIC_MARKS, "")
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) - (d < "۰" ? 0x0660 : 0x06f0)) % 10))
    .toLowerCase();
  return folded.replace(SEPARATORS, " ").trim().replace(/ {2,}/g, " ");
}

/** Normalised tokens (words) of a text. */
export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  return normalized ? normalized.split(" ") : [];
}

/** True when `haystack` contains `needle` after normalisation (prefix of a word or anywhere). */
export function includesNormalized(haystack: string, needle: string): boolean {
  const n = normalizeText(needle);
  return n.length > 0 && normalizeText(haystack).includes(n);
}
