// In-process help search (design phase-5 D25): the /aide search box, and the assistant's fallback
// when the Meilisearch `help` index cannot answer (not configured in development, outage). The
// corpus is a few dozen short articles, so a scan with field weights is enough. Folding: case,
// Latin accents, Arabic diacritics and letter variants, Arabic-Indic digits, the Arabic article.
// Pure and client-safe.

export interface HelpEntry {
  slug: string;
  title: string;
  summary: string;
  keywords: readonly string[];
  /** Plain body text (optional on the client, where only titles, summaries and keywords travel). */
  body?: string;
}

const STOP_WORDS = new Set([
  // French
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "a", "au", "aux", "en", "dans", "sur", "pour", "par", "avec", "sans",
  "je", "j", "me", "mon", "ma", "mes", "il", "elle", "on", "nous", "vous", "ce", "cet", "cette", "est", "sont", "que", "qui", "quoi",
  "comment", "pourquoi", "quand", "ne", "pas", "plus", "faire", "fait", "peut", "peux", "puis", "veux", "veut", "dois", "doit", "faut",
  "suis", "ai", "as", "etre", "avoir", "tu", "te", "ton", "ta", "tes", "votre", "vos", "notre", "nos", "son", "sa", "ses", "se", "leur",
  "quel", "quelle", "quels", "quelles", "si", "ca", "cela", "mais", "donc", "car", "l", "d", "qu", "s", "y", "c", "n", "m", "t",
  // Arabic
  "في", "من", "على", "الى", "الي", "عن", "مع", "كيف", "ما", "ماذا", "هل", "ان", "او", "لا", "هو", "هي", "انا", "هذا", "هذه",
  // Tarifit (Latin)
  "ad", "deg", "di", "zi", "ɣer", "niɣ", "mamec", "min",
]);

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Lower case, no Latin accents, no Arabic diacritics or tatweel, unified alef/ya/ta marbuta, ASCII digits. */
export function foldHelpText(text: string): string {
  return text
    .replace(ARABIC_DIGITS, (digit) => String((digit.charCodeAt(0) & 0xf) % 10))
    .normalize("NFKD")
    .replace(/[̀-ًͯ-ٰٟـ]/g, "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/œ/g, "oe");
}

const ARABIC_PREFIXES = ["وال", "فال", "بال", "كال", "لل", "ال", "و", "ف"];
const ARABIC_SUFFIXES = ["ات", "ون", "ين", "ها", "هم", "كم", "نا", "ي", "ه"];

/** Light Arabic stemming: one leading conjunction or article, one plural or pronoun ending (3 letters kept). */
function stem(word: string): string {
  if (!/[\u0621-\u064a]/.test(word)) return word;
  let out = word;
  const prefix = ARABIC_PREFIXES.find((candidate) => out.startsWith(candidate) && out.length - candidate.length >= 3);
  if (prefix) out = out.slice(prefix.length);
  const suffix = ARABIC_SUFFIXES.find((candidate) => out.endsWith(candidate) && out.length - candidate.length >= 3);
  return suffix ? out.slice(0, -suffix.length) : out;
}

/** Words of a folded text, Arabic ones lightly stemmed ("والإعلانات" -> "اعلان"). */
function words(text: string): string[] {
  return foldHelpText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);
}

export function queryTokens(query: string): string[] {
  return [...new Set(words(query).filter((word) => word.length >= 2 && !STOP_WORDS.has(word)))].slice(0, 12);
}

/** 1 for a whole word, 0.75 for a word that starts with the token (3 letters at least), else 0. */
function fieldMatch(fieldWords: readonly string[], token: string): number {
  let best = 0;
  for (const word of fieldWords) {
    if (word === token) return 1;
    if (token.length >= 3 && word.startsWith(token)) best = 0.75;
  }
  return best;
}

const WEIGHTS = { title: 4, keywords: 3, summary: 2, body: 1 } as const;

/** Entries matching `query`, best first (ties keep the input order); empty query: none. */
export function matchHelp<T extends HelpEntry>(entries: readonly T[], query: string, limit = 5): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0 || limit <= 0) return [];
  const scored = entries.map((entry, index) => {
    const fields = {
      title: words(entry.title),
      keywords: words(entry.keywords.join(" ")),
      summary: words(entry.summary),
      body: entry.body ? words(entry.body) : [],
    };
    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      for (const field of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) tokenScore = Math.max(tokenScore, WEIGHTS[field] * fieldMatch(fields[field], token));
      if (tokenScore > 0) matched += 1;
      score += tokenScore;
    }
    // Entries that match more of the question's words rank first.
    return { entry, index, score: score * (matched / tokens.length) };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.entry);
}
