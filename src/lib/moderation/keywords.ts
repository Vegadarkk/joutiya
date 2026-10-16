import { normalizeText, tokenize } from "@/lib/text/normalize";

// Token-level keyword matcher shared by the prohibited and sensitive detectors. Keywords and texts
// go through the same `normalizeText` (never a second normaliser): a keyword is a sequence of
// normalised tokens that must appear as consecutive whole tokens. Each text token is compared in a
// few folded variants: as is, without a Latin plural -s/-x, without an Arabic conjunction and/or
// article prefix (و، ف، ب، ل، ك + ال). Pure, client-safe.

export interface CompiledKeyword {
  /** Original term from the config. */
  term: string;
  tokens: readonly string[];
}

export interface KeywordHit {
  term: string;
  /** Token index of the first token. */
  start: number;
  /** Token index after the last token. */
  end: number;
}

const ARABIC_LETTER = /^[؀-ۿ]/;
const ARABIC_CONJUNCTIONS = ["و", "ف", "ب", "ل", "ك"];

/** French elision glues the article to the word once apostrophes are dropped ("l'arme" -> "larme"). */
const ELIDABLE = /^[aeiouyh][a-z]/;
const ELIDED_ARTICLES = ["l", "d"];

/**
 * Compiles config terms. A Latin term starting with a vowel or h gets extra variants with an elided
 * article ("heroine" also matches "lheroine", "dheroine"); every variant reports the config term.
 */
export function compileKeywords(terms: readonly string[]): CompiledKeyword[] {
  const out: CompiledKeyword[] = [];
  for (const term of terms) {
    const tokens = tokenize(term);
    const first = tokens[0];
    if (first === undefined) continue;
    out.push({ term, tokens });
    if (ELIDABLE.test(first)) {
      for (const article of ELIDED_ARTICLES) out.push({ term, tokens: [article + first, ...tokens.slice(1)] });
    }
  }
  return out;
}

/** Folded forms under which a text token may equal a keyword token. Always starts with the token itself. */
export function tokenVariants(token: string): string[] {
  const variants = [token];
  if (ARABIC_LETTER.test(token)) {
    let stem = token;
    if (stem.length >= 4 && ARABIC_CONJUNCTIONS.includes(stem[0] ?? "")) {
      stem = stem.slice(1);
      variants.push(stem);
    }
    if (stem.length >= 5 && stem.startsWith("ال")) variants.push(stem.slice(2));
  } else if (token.length > 3 && (token.endsWith("s") || token.endsWith("x")) && !/\d$/.test(token.slice(0, -1))) {
    variants.push(token.slice(0, -1));
  }
  return variants;
}

/** Normalised tokens of a text with their variants, computed once per text. */
export class TokenizedText {
  readonly tokens: readonly string[];
  private readonly index = new Map<string, number[]>();

  constructor(text: string) {
    this.tokens = tokenize(text);
    this.tokens.forEach((token, position) => {
      for (const variant of tokenVariants(token)) {
        const positions = this.index.get(variant);
        if (positions) positions.push(position);
        else this.index.set(variant, [position]);
      }
    });
  }

  private matchesAt(position: number, expected: string): boolean {
    const token = this.tokens[position];
    return token !== undefined && tokenVariants(token).includes(expected);
  }

  /** Every occurrence of the keywords, in text order then config order. */
  find(keywords: readonly CompiledKeyword[]): KeywordHit[] {
    const hits: KeywordHit[] = [];
    for (const keyword of keywords) {
      const first = keyword.tokens[0];
      if (first === undefined) continue;
      for (const start of this.index.get(first) ?? []) {
        let ok = true;
        for (let offset = 1; offset < keyword.tokens.length && ok; offset += 1) {
          ok = this.matchesAt(start + offset, keyword.tokens[offset] ?? "");
        }
        if (ok) hits.push({ term: keyword.term, start, end: start + keyword.tokens.length });
      }
    }
    return hits.sort((a, b) => a.start - b.start || a.end - b.end);
  }
}

/** Normalised single-line form of a term, for list integrity checks. */
export function normalizeTerm(term: string): string {
  return normalizeText(term);
}
