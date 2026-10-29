import { SEARCH_PRICE_MAX, ZONE_KM_MAX } from "@/lib/search/params";
import { phraseTokens, type Token } from "./tokens";

// Prices and distances of a typed search: "moins de 500", "< 500 dh", "max 3000", "entre 1000 et
// 2000", "500 dh max", "أقل من 500", "a9al mn 500"; "à 2 km", "dans un rayon de 5 km". A number
// becomes a price only next to a price word or a currency, and never when another unit follows it
// ("moins de 2 ans", "128 go", "100 000 km"); the price words of such an amount are reported apart
// (unreadPriceCues) so the words left do not keep them. Pure.

export interface PriceMatch {
  kind: "price";
  min?: number;
  max?: number;
  tokens: number[];
}

export interface DistanceMatch {
  kind: "distance";
  km: number;
  tokens: number[];
}

type Cue = { tokens: readonly string[]; strong: boolean };
const cues = (strong: boolean, phrases: string[]): Cue[] =>
  phrases.map((phrase) => {
    const tokens = phraseTokens(phrase);
    if (tokens.length === 0) throw new Error(`empty cue: ${phrase}`);
    return { tokens, strong };
  });

/** Before a ceiling. Strong cues need no currency (a bare number of 50 or more). */
const MAX_CUES: Cue[] = [
  ...cues(true, ["moins de", "a moins de", "moins que", "max", "maxi", "maximum", "au maximum", "jusqu a", "jusqu au", "pas plus de", "au plus", "inferieur a", "en dessous de", "budget", "budget max", "budget de", "<", "≤", "أقل من", "اقل من", "بأقل من", "لا يتجاوز", "a9al mn", "a9al men", "a9al min", "aqal mn", "aqal men", "b9al mn", "b9el mn"]),
  ...cues(false, ["sous", "حتى"]),
];
/** Before a floor. */
const MIN_CUES: Cue[] = [
  ...cues(true, ["plus de", "a partir de", "au moins", "minimum", "min", "superieur a", ">", "≥", "أكثر من", "اكثر من", "ابتداء من", "kter mn", "ktar mn", "kter men"]),
  ...cues(false, ["des"]),
];
/** After an amount. */
const MAX_AFTER = ["max", "maxi", "maximum", "au maximum", "ou moins", "et moins", "كحد أقصى", "أقصى"].map(phraseTokens);
const MIN_AFTER = ["minimum", "min", "ou plus", "et plus", "au moins"].map(phraseTokens);
/** Opening words of a range: "entre 1000 et 2000"; "de", "من" only with a currency. */
const RANGE_OPEN: Cue[] = [...cues(true, ["entre", "bin", "بين"]), ...cues(false, ["de", "من"])];
const RANGE_JOIN = new Set(["et", "a", "w", "و", "الى", "إلى", "l"].map((word) => phraseTokens(word).join(" ")));

const CURRENCIES = ["dh", "dhs", "mad", "drh", "dirham", "dirhams", "درهم", "دراهم", "درهما", "د م"].map(phraseTokens);
/** A thousand: "3k", "5 mille", "5 آلاف". "million" is left alone (often 10 000 DH in speech). */
const THOUSANDS = new Set(["k", "mille", "alf", "alaf", "الف", "الاف", "آلاف"].map((word) => phraseTokens(word).join(" ")));
const AMBIGUOUS_SCALE = new Set(["million", "millions", "mlyoun", "melyoun", "مليون", "ملايين"].map((word) => phraseTokens(word).join(" ")));
/** Any other unit after the number: not a price. Rials and centimes are prices in another unit: left as words. */
const OTHER_UNITS = new Set(
  ["km", "kms", "m", "m2", "cm", "mm", "kg", "g", "l", "litre", "litres", "go", "gb", "to", "tb", "mo", "mb", "cc", "cv", "ch", "an", "ans", "mois", "jour", "jours", "j", "h", "heures", "piece", "pieces", "chambre", "chambres", "place", "places", "pouce", "pouces", "personne", "personnes", "w", "kw", "v", "mah", "mp", "hz", "ryal", "rial", "rials", "ريال", "centime", "centimes", "سنتيم", "كم", "كلم", "متر", "سنة", "سنوات", "غرف"].map((word) => phraseTokens(word).join(" ")),
);
const KM_UNITS = new Set(["km", "kms", "kilometre", "kilometres", "كم", "كلم", "كيلومتر"].map((word) => phraseTokens(word).join(" ")));
const METRE_UNITS = new Set(["m", "metre", "metres", "متر"].map((word) => phraseTokens(word).join(" ")));
/** Before a distance: "à 2 km", "dans un rayon de 5 km", "على بعد 3 كلم"; "moins de" only with "de moi" after. */
const DISTANCE_CUES = [...cues(true, ["a", "a moins de", "dans un rayon de", "rayon de", "dans un rayon d", "على بعد", "3la", "ala"]), ...cues(false, ["moins de"])];
/** After a distance: "2 km autour", "à 3 km de moi". */
const DISTANCE_AFTER = ["de moi", "de chez moi", "d ici", "autour", "autour de moi", "مني", "حولي"].map(phraseTokens);
/** Model names end with these before a number: "pro max 256" is a phone, not a ceiling. */
const MODEL_WORDS = new Set(["pro", "plus", "ultra", "air", "note", "mini", "lite"]);
/** Short cues that also end model names ("max", "mini"): bare amounts only when no model word precedes. */
const MODEL_CUES = new Set(["max", "maxi", "min"]);
/** A ceiling without currency needs at least this much: "moins de 5" is rarely a price. */
const BARE_AMOUNT_MIN = 50;
/** "à 2 km": a distance asked around the visitor at most this far. */
const DISTANCE_KM_MAX = 100;

function at(tokens: readonly Token[], index: number, phrase: readonly string[], taken: ReadonlySet<number>): boolean {
  return phrase.every((word, offset) => tokens[index + offset]?.norm === word && !taken.has(index + offset));
}

function longest(tokens: readonly Token[], index: number, phrases: readonly (readonly string[])[], taken: ReadonlySet<number>): number {
  let best = 0;
  for (const phrase of phrases) if (phrase.length > best && at(tokens, index, phrase, taken)) best = phrase.length;
  return best;
}

function longestCue(tokens: readonly Token[], index: number, list: readonly Cue[], taken: ReadonlySet<number>): Cue | undefined {
  let best: Cue | undefined;
  for (const cue of list) if ((!best || cue.tokens.length > best.tokens.length) && at(tokens, index, cue.tokens, taken)) best = cue;
  return best;
}

interface Amount {
  value: number;
  /** Next token after the amount, currency included. */
  end: number;
  currency: boolean;
  /** Another unit follows: not a price. */
  otherUnit: string | null;
}

/** Text between two tokens, as typed. */
const gap = (text: string, a: Token, b: Token) => text.slice(a.end, b.start);

function readAmount(text: string, tokens: readonly Token[], index: number, taken: ReadonlySet<number>): Amount | null {
  const first = tokens[index];
  if (!first || taken.has(index) || !/^\d{1,12}$/.test(first.norm)) return null;
  let value = Number(first.norm);
  let end = index + 1;
  // "3 000", "3.000", "1 500 000": groups of three digits after a short first group.
  for (let next = tokens[end]; next && !taken.has(end) && /^\d{3}$/.test(next.norm) && first.norm.length <= 3 && /^[\s.,'’  ]$/.test(gap(text, tokens[end - 1] as Token, next)); next = tokens[end]) {
    value = value * 1000 + Number(next.norm);
    end += 1;
  }
  const scale = tokens[end];
  if (scale && !taken.has(end) && AMBIGUOUS_SCALE.has(scale.norm)) return null;
  if (scale && !taken.has(end) && THOUSANDS.has(scale.norm)) {
    value *= 1000;
    end += 1;
  }
  const currency = longest(tokens, end, CURRENCIES, taken);
  if (currency > 0) end += currency;
  const unit = currency > 0 ? null : (tokens[end]?.norm ?? null);
  const otherUnit = unit !== null && OTHER_UNITS.has(unit) ? unit : null;
  if (!Number.isSafeInteger(value) || value > SEARCH_PRICE_MAX) return null;
  return { value, end, currency: currency > 0, otherUnit };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => from + offset);

/** A one-word cue ending a model name here ("pro max 256"): not a price word. */
function modelCue(tokens: readonly Token[], index: number, cue: Cue): boolean {
  return index > 0 && MODEL_WORDS.has(tokens[index - 1]?.norm ?? "") && cue.tokens.length === 1 && MODEL_CUES.has(cue.tokens[0] ?? "");
}

function priceAmount(amount: Amount | null, strong: boolean): amount is Amount {
  return amount !== null && amount.otherUnit === null && (amount.currency || (strong && amount.value >= BARE_AMOUNT_MIN));
}

function distanceAt(text: string, tokens: readonly Token[], index: number, taken: ReadonlySet<number>): DistanceMatch | null {
  const cue = longestCue(tokens, index, DISTANCE_CUES, taken);
  const start = index + (cue?.tokens.length ?? 0);
  const amount = readAmount(text, tokens, start, taken);
  if (!amount || amount.currency || amount.value < 1) return null;
  const unit = tokens[amount.end]?.norm ?? "";
  const metres = METRE_UNITS.has(unit);
  if (!KM_UNITS.has(unit) && !metres) return null;
  let end = amount.end + 1;
  const after = longest(tokens, end, DISTANCE_AFTER, taken);
  end += after;
  // A distance needs its words: "à 2 km", "2 km autour"; "moins de 100 000 km" is a mileage.
  if ((!cue || !cue.strong) && after === 0) return null;
  const km = metres ? Math.ceil(amount.value / 1000) : amount.value;
  if (km > DISTANCE_KM_MAX || km > ZONE_KM_MAX) return null;
  return { kind: "distance", km: Math.max(1, km), tokens: range(index, end) };
}

function priceAt(text: string, tokens: readonly Token[], index: number, taken: ReadonlySet<number>): PriceMatch | null {
  // Ranges: "entre 1000 et 2000", "de 1000 à 2000 dh", "1000-2000 dh".
  const open = longestCue(tokens, index, RANGE_OPEN, taken);
  const from = index + (open?.tokens.length ?? 0);
  const low = readAmount(text, tokens, from, taken);
  if (low && low.otherUnit === null) {
    const joinToken = tokens[low.end];
    const joined = joinToken && !taken.has(low.end) && RANGE_JOIN.has(joinToken.norm);
    const dashed = !joined && tokens[low.end] !== undefined && /^\s*[-–]\s*$/.test(gap(text, tokens[low.end - 1] as Token, tokens[low.end] as Token));
    const high = joined || dashed ? readAmount(text, tokens, low.end + (joined ? 1 : 0), taken) : null;
    if (high && high.otherUnit === null) {
      const currency = low.currency || high.currency;
      const strong = open?.strong === true;
      if (currency || (strong && high.value >= BARE_AMOUNT_MIN)) {
        return { kind: "price", min: Math.min(low.value, high.value), max: Math.max(low.value, high.value), tokens: range(index, high.end) };
      }
    }
  }
  const strength = (cue: Cue) => cue.strong && !modelCue(tokens, index, cue);
  const max = longestCue(tokens, index, MAX_CUES, taken);
  if (max) {
    const amount = readAmount(text, tokens, index + max.tokens.length, taken);
    if (priceAmount(amount, strength(max))) return { kind: "price", max: amount.value, tokens: range(index, amount.end + longest(tokens, amount.end, MAX_AFTER, taken)) };
  }
  const min = longestCue(tokens, index, MIN_CUES, taken);
  if (min) {
    const amount = readAmount(text, tokens, index + min.tokens.length, taken);
    if (priceAmount(amount, strength(min))) return { kind: "price", min: amount.value, tokens: range(index, amount.end + longest(tokens, amount.end, MIN_AFTER, taken)) };
  }
  // "500 dh max", "3000 maximum", "1000 dh et plus".
  const amount = readAmount(text, tokens, index, taken);
  if (amount && amount.otherUnit === null) {
    const ceiling = longest(tokens, amount.end, MAX_AFTER, taken);
    if (ceiling > 0 && priceAmount(amount, true)) return { kind: "price", max: amount.value, tokens: range(index, amount.end + ceiling) };
    const floor = longest(tokens, amount.end, MIN_AFTER, taken);
    if (floor > 0 && priceAmount(amount, true)) return { kind: "price", min: amount.value, tokens: range(index, amount.end + floor) };
  }
  return null;
}

const PRICE_CUES: Cue[] = [...MAX_CUES, ...MIN_CUES].filter((cue) => cue.strong);
const PRICE_AFTER = [...MAX_AFTER, ...MIN_AFTER];

/**
 * Price words left without a price, their amount read with another unit: "moins de" in "moins de
 * 100 000 km", "plus de" in "plus de 2 ans", "max" in "100 000 km max". Token indices of those
 * words only: the amount and its unit stay words, like any number with a unit ("voiture 150 000
 * km"). Strong cues only ("des", "sous" are ordinary words too); `taken`: tokens already matched.
 */
export function unreadPriceCues(text: string, tokens: readonly Token[], taken: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (taken.has(index)) continue;
    const cue = longestCue(tokens, index, PRICE_CUES, taken);
    if (cue && !modelCue(tokens, index, cue) && readAmount(text, tokens, index + cue.tokens.length, taken)?.otherUnit) {
      out.push(...range(index, index + cue.tokens.length));
      // The amount comes next: a cue after it ("moins de 2 ans max") is read there.
      index += cue.tokens.length - 1;
      continue;
    }
    const amount = readAmount(text, tokens, index, taken);
    if (!amount?.otherUnit) continue;
    const after = longest(tokens, amount.end + 1, PRICE_AFTER, taken);
    out.push(...range(amount.end + 1, amount.end + 1 + after));
    index = amount.end + after;
  }
  return out;
}

/** Prices and distances, left to right; each token belongs to one match at most. */
export function findAmounts(text: string, tokens: readonly Token[]): (PriceMatch | DistanceMatch)[] {
  const taken = new Set<number>();
  const out: (PriceMatch | DistanceMatch)[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (taken.has(index)) continue;
    const match = distanceAt(text, tokens, index, taken) ?? priceAt(text, tokens, index, taken);
    if (!match) continue;
    for (const token of match.tokens) taken.add(token);
    out.push(match);
    index = Math.max(...match.tokens);
  }
  return out;
}
