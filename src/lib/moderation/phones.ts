import { findPhoneNumbersInText, parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { PhoneMatch } from "@/lib/moderation/types";

// Phone numbers written in a listing text (architecture §7 step 3: blocked, « Utilisez le bouton
// Voir le numéro »). libphonenumber (region MA, same "max" metadata as src/lib/phone/normalize.ts)
// runs on a de-obfuscated copy of the text, then a regex catches the Moroccan shapes it misses.
// Pure, client-safe (usable for inline wizard hints).
//
// De-obfuscation keeps the string length so spans map back to the original text:
//   Arabic-Indic digits -> ASCII, "o"/"O" standing for a zero -> "0", separators libphonenumber
//   does not accept (/ _ * | ...) -> space.
// False-positive guards (tests/unit/moderation-phones.test.ts): years, prices, mileage and model
// numbers never form a Moroccan number; dd/mm/yyyy dates are excluded explicitly; a national
// number without its trunk 0 ("6 12 34 56 78") is accepted only when written without separators.

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;
const O_AS_ZERO = /(?<![a-zA-Z0-9])[oO](?=[\s./_-]*\d)|(?<=\d[\s./_-]*)[oO](?![a-zA-Z])/g;
const EXTRA_SEPARATORS = /[/_*|•·]/g;
/** dd/mm/yyyy, dd.mm.yy...: not when more digit groups follow (that is a dotted phone number). */
const DATE = /(?<![\d/.-])\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?![/.-]?\d)/g;
/** Moroccan shapes: +212 / 00212 / 212 then 5-7 + 8 digits, or 0 + 5-7 + 8 digits; single separators between digits. */
const MOROCCAN_SHAPE = /(?<!\d)(?:(?:\+|00)?\s?212[\s.-]?\(?0?\)?[\s.-]?[5-7](?:[\s.-]?\d){8}|0[5-7](?:[\s.-]?\d){8})(?!\d)/g;

interface Span {
  start: number;
  end: number;
}

function asciiDigit(digit: string): string {
  const code = digit.charCodeAt(0);
  return String((code - (code >= 0x06f0 ? 0x06f0 : 0x0660)) % 10);
}

/** Same length as the input: spans computed on the result are valid on the input. */
export function deobfuscatePhoneText(text: string): string {
  return text.replace(ARABIC_INDIC_DIGITS, asciiDigit).replace(O_AS_ZERO, "0").replace(EXTRA_SEPARATORS, " ");
}

function spans(text: string, pattern: RegExp): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(pattern)) out.push({ start: match.index, end: match.index + match[0].length });
  return out;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** E.164 of a Moroccan shape; undefined when libphonenumber does not consider it possible. */
function moroccanE164(digits: string): string | undefined {
  let national: string;
  if (digits.startsWith("00212")) national = digits.slice(5);
  else if (digits.startsWith("212")) national = digits.slice(3);
  else national = digits.replace(/^0/, "");
  national = national.replace(/^0/, "");
  const parsed = parsePhoneNumberFromString(`+212${national}`);
  return parsed?.isPossible() ? parsed.number : undefined;
}

/**
 * Phone numbers found in a free text, deduplicated (by E.164, else by digits), in text order.
 * `raw` is the text as written (for highlighting in the wizard), `e164` when the number parses.
 */
export function findPhoneNumbers(text: string): PhoneMatch[] {
  if (!text || !/\d|[٠-٩۰-۹]/.test(text)) return [];
  const clean = deobfuscatePhoneText(text);
  const dates = spans(text, DATE);
  const found: { span: Span; match: PhoneMatch }[] = [];
  const seen = new Set<string>();
  const add = (span: Span, e164: string | undefined) => {
    if (dates.some((date) => overlaps(date, span))) return;
    if (found.some((entry) => overlaps(entry.span, span))) return;
    const raw = text.slice(span.start, span.end);
    const key = e164 ?? digitsOf(raw);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ span, match: e164 ? { raw, e164 } : { raw } });
  };

  for (const hit of findPhoneNumbersInText(clean, "MA")) {
    const span = { start: hit.startsAt, end: hit.endsAt };
    const written = clean.slice(span.start, span.end);
    const digits = digitsOf(written);
    const explicitPrefix = /^\s*(?:\+|00|0|\(|212)/.test(written) || written.includes("212");
    // "6 12 34 56 78" style (no trunk 0, spaced) is too close to lists of numbers.
    if (!explicitPrefix && digits.length === 9 && /\D/.test(written.trim())) continue;
    if (!hit.number.isPossible()) continue;
    add(span, hit.number.number);
  }
  for (const span of spans(clean, MOROCCAN_SHAPE)) {
    add(span, moroccanE164(digitsOf(clean.slice(span.start, span.end))));
  }
  return found.sort((a, b) => a.span.start - b.span.start).map((entry) => entry.match);
}

/** True when the text contains at least one phone number. */
export function containsPhoneNumber(text: string): boolean {
  return findPhoneNumbers(text).length > 0;
}
