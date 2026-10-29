import { normalizeText } from "@/lib/text/normalize";

// Words of a typed search for the interpreter ("Chercher en parlant", Carte vivante lot 4). Client-safe.
// Each token keeps its place in the text, so the words left over are cut from the text as typed
// ("128go", "3.000" and punctuation inside a run survive), and a normalized form for matching
// (normalizeText: case, accents, Arabic letter variants and Arabic-Indic digits folded).

export interface Token {
  /** As typed (Arabic-Indic digits folded to ASCII). */
  raw: string;
  /** Matching form (normalizeText). */
  norm: string;
  start: number;
  end: number;
}

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
/** Comparison signs stand alone; words are runs of letters, marks and digits (apostrophes and dashes split). */
const WORD = /[<>≤≥]|[\p{L}\p{M}\p{N}]+/gu;
/** A number glued to a currency, a distance or a thousand ("500dh", "2km", "3k", "500درهم"). */
const NUMBER_UNIT = /^(\d+)(dhs?|mad|drh|km|kms|k|درهم|دراهم)$/u;
/** One or two Arabic letters glued to a number ("و2000", "ب500"). */
const PREFIX_NUMBER = /^(\p{Script=Arabic}{1,2})(\d+)$/u;

/** Same length as the input: offsets of the folded text are offsets of the typed one. */
export function foldEasternDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => String((digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)) % 10));
}

const SIGN = /^[<>≤≥]$/;

function push(tokens: Token[], raw: string, start: number) {
  // normalizeText drops the comparison signs (separators for it): kept as they are.
  const norm = SIGN.test(raw) ? raw : normalizeText(raw);
  if (norm) tokens.push({ raw, norm, start, end: start + raw.length });
}

export function tokenizeQuery(text: string): Token[] {
  const folded = foldEasternDigits(text);
  const tokens: Token[] = [];
  for (const match of folded.matchAll(WORD)) {
    const raw = match[0];
    const start = match.index;
    const unit = NUMBER_UNIT.exec(raw.toLowerCase());
    const prefix = unit ? null : PREFIX_NUMBER.exec(raw);
    const split = unit ? (unit[1] ?? "").length : prefix ? (prefix[1] ?? "").length : 0;
    if (split > 0) {
      push(tokens, raw.slice(0, split), start);
      push(tokens, raw.slice(split), start + split);
    } else push(tokens, raw, start);
  }
  return tokens;
}

/** Normalized words of a lexicon phrase (same splitting as a query). */
export function phraseTokens(phrase: string): string[] {
  return tokenizeQuery(phrase).map((token) => token.norm);
}

const ARABIC_LETTER = /^\p{Script=Arabic}/u;
/** Proclitics stripped from an Arabic word ("بالدار" -> "الدار" -> "دار", "للكراء" -> "كراء"). */
const PROCLITICS = ["وال", "بال", "فال", "كال", "لل", "ال", "و", "ب", "ف", "ل"] as const;
/** Proclitics that mean "in" or "at": the word was a place ("بالعيون", "فكازا"). */
const PLACE_PROCLITICS: ReadonlySet<string> = new Set(["بال", "فال", "ب", "ف"]);

export interface TokenForm {
  form: string;
  /** Reached by stripping an "in/at" proclitic. */
  place: boolean;
}

/** The token and, for an Arabic word, the same word without its proclitics. */
export function tokenForms(norm: string): TokenForm[] {
  const forms: TokenForm[] = [{ form: norm, place: false }];
  if (!ARABIC_LETTER.test(norm)) return forms;
  for (const proclitic of PROCLITICS) {
    if (norm.startsWith(proclitic) && norm.length - proclitic.length >= 2) forms.push({ form: norm.slice(proclitic.length), place: PLACE_PROCLITICS.has(proclitic) });
  }
  return forms;
}

/**
 * The words of `text` whose token indices are kept, as typed: each run of consecutive kept tokens
 * is cut from the text in one piece, runs joined by one space.
 */
export function keptText(text: string, tokens: readonly Token[], keep: (index: number) => boolean): string {
  const folded = foldEasternDigits(text);
  const runs: string[] = [];
  let runStart = -1;
  let runEnd = -1;
  tokens.forEach((token, index) => {
    if (keep(index)) {
      if (runStart < 0) runStart = token.start;
      runEnd = token.end;
      return;
    }
    if (runStart >= 0) runs.push(folded.slice(runStart, runEnd));
    runStart = -1;
  });
  if (runStart >= 0) runs.push(folded.slice(runStart, runEnd));
  return runs.join(" ").replace(/\s+/g, " ").trim();
}
