import {
  ID_NUMBER_STOPLIST,
  PERSON_MARKERS,
  RESTRICTION_MARKERS,
  SENSITIVE_CATEGORY_IDS,
  SENSITIVE_VOCABULARY,
  SENSITIVE_WINDOW,
  type SensitiveCategoryId,
} from "@/config/sensitive";
import { TokenizedText, compileKeywords, type CompiledKeyword, type KeywordHit } from "@/lib/moderation/keywords";
import { normalizeText } from "@/lib/text/normalize";

// Sensitive personal data in a listing text (architecture §7 step 3, Russmedia). Patterns for
// identity, bank and card numbers; vocabulary with a context rule (src/config/sensitive.ts). Soft
// signal only: the result feeds the `sensitive_text` flag and the moderator's evidence. Pure,
// client-safe. Third-party names are out of scope (no NER); phone numbers are handled by phones.ts.

export interface SensitiveHit {
  id: SensitiveCategoryId;
  /** Short reason for the moderator, never the matched value. */
  evidence: string;
}

/** 1-2 letters then 6-7 digits (CIN "AB123456", passport "XY1234567"), a single space allowed. */
const ID_NUMBER = /(?<![a-z0-9])([a-z]{1,2}) ?(\d{6,7})(?!\d)/gi;
/** 24 digits with optional single separators (Moroccan RIB). */
const RIB = /(?<!\d)(?:\d[ .-]?){23}\d(?!\d)/g;
/** IBAN: country, 2 check digits, 11-30 alphanumerics in groups of 4. Validated mod 97. */
const IBAN = /(?<![a-z0-9])([a-z]{2}\d{2}(?:\s?[a-z0-9]{4}){3,7}(?:\s?[a-z0-9]{1,3})?)(?![a-z0-9])/gi;
/** 13-19 digits with optional single separators (card numbers), validated by Luhn + issuer prefix. */
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

interface Span {
  start: number;
  end: number;
}
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Visa 4 (13-19), Mastercard 51-55 / 2221-2720 (16), Maestro/Discover 6 (16), Amex 34/37 (15). */
function plausibleCardPrefix(digits: string): boolean {
  const n = digits.length;
  if (digits.startsWith("4")) return n === 13 || n === 16 || n === 19;
  if (n === 16) {
    if (/^5[1-5]/.test(digits) || digits.startsWith("6")) return true;
    const four = Number(digits.slice(0, 4));
    return four >= 2221 && four <= 2720;
  }
  return n === 15 && /^3[47]/.test(digits);
}

function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function patternHits(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  const taken: Span[] = [];
  const claim = (span: Span) => {
    if (taken.some((other) => overlaps(other, span))) return false;
    taken.push(span);
    return true;
  };
  // Bank first: a spaced RIB contains card-sized runs.
  for (const match of text.matchAll(IBAN)) {
    const compact = match[0].replace(/\s/g, "").toUpperCase();
    if (ibanValid(compact) && claim({ start: match.index, end: match.index + match[0].length })) {
      hits.push({ id: "bank_account", evidence: "iban pattern" });
    }
  }
  for (const match of text.matchAll(RIB)) {
    if (claim({ start: match.index, end: match.index + match[0].length })) hits.push({ id: "bank_account", evidence: "rib pattern" });
  }
  for (const match of text.matchAll(CARD)) {
    const digits = match[0].replace(/\D/g, "");
    if (plausibleCardPrefix(digits) && luhnValid(digits) && claim({ start: match.index, end: match.index + match[0].length })) {
      hits.push({ id: "card_number", evidence: "card number pattern" });
    }
  }
  for (const match of text.matchAll(ID_NUMBER)) {
    const letters = normalizeText(match[1] ?? "");
    if (ID_NUMBER_STOPLIST.has(letters)) continue;
    if (claim({ start: match.index, end: match.index + match[0].length })) hits.push({ id: "id_number", evidence: "identity number pattern" });
  }
  return hits;
}

interface CompiledVocabulary {
  id: SensitiveCategoryId;
  context: "always" | "person" | "person_or_restriction";
  keywords: CompiledKeyword[];
}

let vocabulary: CompiledVocabulary[] | undefined;
let personMarkers: CompiledKeyword[] | undefined;
let restrictionMarkers: CompiledKeyword[] | undefined;

function compiledVocabulary(): CompiledVocabulary[] {
  vocabulary ??= SENSITIVE_VOCABULARY.map((entry) => ({ id: entry.id, context: entry.context, keywords: compileKeywords(entry.terms) }));
  return vocabulary;
}

function near(hit: KeywordHit, markers: KeywordHit[]): boolean {
  return markers.some((marker) => marker.end > hit.start - SENSITIVE_WINDOW && marker.start < hit.end + SENSITIVE_WINDOW);
}

function vocabularyHits(text: string): SensitiveHit[] {
  const tokens = new TokenizedText(text);
  personMarkers ??= compileKeywords(PERSON_MARKERS);
  restrictionMarkers ??= compileKeywords(RESTRICTION_MARKERS);
  const persons = tokens.find(personMarkers);
  const restrictions = tokens.find(restrictionMarkers);
  const hits: SensitiveHit[] = [];
  for (const entry of compiledVocabulary()) {
    for (const hit of tokens.find(entry.keywords)) {
      if (entry.context === "always") hits.push({ id: entry.id, evidence: `${entry.id} vocabulary` });
      else if (near(hit, persons)) hits.push({ id: entry.id, evidence: `${entry.id} vocabulary near a person marker` });
      else if (entry.context === "person_or_restriction" && near(hit, restrictions)) {
        hits.push({ id: entry.id, evidence: `${entry.id} vocabulary near a restriction marker` });
      }
    }
  }
  return hits;
}

/** Detailed hits (one per occurrence), in SENSITIVE_CATEGORY_IDS order. */
export function detectSensitiveDetailed(text: string): SensitiveHit[] {
  if (!text) return [];
  const order = new Map(SENSITIVE_CATEGORY_IDS.map((id, index) => [id, index] as const));
  return [...patternHits(text), ...vocabularyHits(text)].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Sensitive categories found in a text, unique, in SENSITIVE_CATEGORY_IDS order. */
export function detectSensitive(text: string): SensitiveCategoryId[] {
  return [...new Set(detectSensitiveDetailed(text).map((hit) => hit.id))];
}
