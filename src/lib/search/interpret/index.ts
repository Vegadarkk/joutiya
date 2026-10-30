import { categoryById, subcategoryById, type Condition } from "@/config/categories";
import { canonicalSearchParams, effectiveSort, type CriterionFilter, type SearchParams, type SearchSort, type SellerTypeFilter } from "@/lib/search/params";
import { FILLER_WORDS, PLACE_WORDS, lexiconPhrases, type Entry, type PhraseEntry, type ThingEntry } from "./lexicon";
import { findAmounts, unreadPriceCues } from "./prices";
import { keptText, tokenForms, tokenizeQuery, type Token } from "./tokens";

// "Chercher en parlant" (Carte vivante, lot 4): a typed sentence turned into the search filters it
// clearly names, the rest kept as words. Rule based and deterministic: no model call (search is the
// busiest route and the AI budget is capped). Client-safe and pure.
//
// interpretQuery reads the words once; applyInterpretation lays the result over the filters the URL
// already sets (the URL wins: a filter it sets is never replaced) and gives, for each understood
// item, the search without it. Only parameters of the search whitelist come out, through
// canonicalSearchParams. A word of a category or a place the URL contradicts stays a word; a word
// of price, sort or condition is dropped either way (as search words they would only empty the
// results). "Près de moi" is an intent: the page asks the browser position after a click.

export type UnderstoodKey = "category" | `criterion:${string}` | "location" | "price" | "conditions" | "donation" | "withPhoto" | "sellerType" | "sort" | "near";

/** Radius of « près de moi » without a distance, km. */
export const NEAR_KM = 3;

export interface Understood {
  key: UnderstoodKey;
  /** The words it came from, as typed ("pas cher", "à côté"). */
  label: string;
  /** Parameters it sets (none for "near"). */
  patch: SearchParams;
  /** Token indices it consumed. */
  tokens: readonly number[];
  /** A category or a place: its words return to the text when it is removed or contradicted. */
  content: boolean;
  /** "criterion:*" items read from a category word or a modifier: they need the category item. */
  needsCategory?: true;
  /** "near": radius asked, km. */
  km?: number;
}

export interface Interpretation {
  text: string;
  tokens: readonly Token[];
  understood: Understood[];
  /** Words consumed without a filter ("occasion" where no condition applies). */
  dropped: readonly number[];
  /** Price words whose amount has another unit ("moins de" in "moins de 100 000 km"): out of the words left, like fillers. */
  unreadCues: readonly number[];
  /** Every understood patch together (canonical). */
  patch: SearchParams;
  /** The words left when every item applies. */
  q: string;
}

// ---- Phrase matching.

let phraseIndex: Map<string, PhraseEntry[]> | undefined;

/** First word -> phrases starting with it, longest first; a phrase listed twice keeps its first meaning. */
function index(): Map<string, PhraseEntry[]> {
  if (phraseIndex) return phraseIndex;
  const seen = new Set<string>();
  const map = new Map<string, PhraseEntry[]>();
  for (const phrase of lexiconPhrases()) {
    const key = phrase.tokens.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const first = phrase.tokens[0] ?? "";
    map.set(first, [...(map.get(first) ?? []), phrase]);
  }
  for (const list of map.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  phraseIndex = map;
  return map;
}

/** Words after which « près » or « à côté » name another place ("à côté de la gare", "قريب من البحر"). */
const NEAR_BREAK = new Set(["de", "du", "des", "d", "a", "au", "من", "mn", "men", "min", "l", "dial", "dyal"]);
/** « gratuit » of something else than the item ("livraison gratuite"). */
const DONATION_BREAK = new Set(["livraison", "livraisons", "installation", "essai", "parking", "wifi", "retour", "tawsil", "توصيل", "التوصيل"]);
/** « neuf » the number ("neuf ans", "neuf pièces"). */
const NINE_UNITS = new Set(["ans", "an", "mois", "pieces", "piece", "chambres", "places", "heures", "jours"]);

interface Match {
  start: number;
  length: number;
  entry: Entry;
}

function sameWord(token: Token | undefined, word: string): boolean {
  return token !== undefined && tokenForms(token.norm).some((form) => form.form === word);
}

function allowed(entry: Entry, tokens: readonly Token[], start: number, end: number, place: boolean): boolean {
  const before = tokens[start - 1]?.norm;
  const after = tokens[end]?.norm;
  switch (entry.kind) {
    case "city":
      return !entry.guarded || place || (before !== undefined && PLACE_WORDS.has(before));
    case "near":
      return after === undefined || !NEAR_BREAK.has(after);
    case "donation":
      return before === undefined || !DONATION_BREAK.has(before);
    case "conditions":
      return after === undefined || !NINE_UNITS.has(after);
    default:
      return true;
  }
}

function matchAt(tokens: readonly Token[], start: number, taken: ReadonlySet<number>): Match | null {
  const first = tokens[start];
  if (!first) return null;
  let best: Match | null = null;
  for (const { form, place } of tokenForms(first.norm)) {
    for (const phrase of index().get(form) ?? []) {
      const length = phrase.tokens.length;
      if (best && best.length >= length) break;
      let ok = true;
      for (let offset = 1; offset < length && ok; offset += 1) ok = !taken.has(start + offset) && sameWord(tokens[start + offset], phrase.tokens[offset] ?? "");
      if (ok && allowed(phrase.entry, tokens, start, start + length, place)) {
        best = { start, length, entry: phrase.entry };
        break;
      }
    }
  }
  return best;
}

// ---- Interpretation.

const span = (match: { start: number; length: number }) => Array.from({ length: match.length }, (_, offset) => match.start + offset);

function labelOf(tokens: readonly Token[], indices: readonly number[]): string {
  return [...new Set(indices)]
    .sort((a, b) => a - b)
    .map((at) => tokens[at]?.raw ?? "")
    .filter(Boolean)
    .join(" ");
}

interface Resolved {
  category: string;
  subcategory?: string;
  criteria: Record<string, string[]>;
}

function resolveThing(thing: ThingEntry, flags: { rent: boolean; sale: boolean; holiday: boolean }): Resolved | null {
  const criteria: Record<string, string[]> = {};
  for (const [id, option] of Object.entries(thing.criteria ?? {})) criteria[id] = [option];
  if (thing.family === "car") return { category: "vehicules", subcategory: flags.rent ? "location-voitures" : "voitures", criteria };
  if (thing.family === "property") {
    const subcategory = flags.holiday ? "location-vacances" : flags.rent ? "location" : flags.sale ? "vente" : undefined;
    return { category: "immobilier", ...(subcategory ? { subcategory } : {}), criteria };
  }
  const sub = thing.subcategory ? subcategoryById(thing.subcategory) : undefined;
  const category = sub?.categoryId ?? thing.category;
  return category ? { category, ...(sub ? { subcategory: sub.id } : {}), criteria } : null;
}

/** Whether a condition filter fits the target: goods that always carry a condition. */
function conditionApplies(target: Resolved | null): boolean {
  if (!target) return true;
  if (target.subcategory) return subcategoryById(target.subcategory)?.condition === "required";
  return categoryById(target.category)?.subcategories.every((sub) => sub.condition === "required") ?? false;
}

const ORDER: readonly string[] = ["category", "criterion", "location", "price", "conditions", "donation", "withPhoto", "sellerType", "sort", "near"];
const rank = (key: UnderstoodKey) => ORDER.indexOf(key.startsWith("criterion:") ? "criterion" : key);

export function interpretQuery(input: string): Interpretation {
  const text = input.replace(/\s+/g, " ").trim();
  const tokens = tokenizeQuery(text);
  const understood: Understood[] = [];
  const dropped: number[] = [];
  const amounts = findAmounts(text, tokens);
  const taken = new Set(amounts.flatMap((match) => match.tokens));
  const matches: Match[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    if (taken.has(at)) continue;
    const match = matchAt(tokens, at, taken);
    if (!match) continue;
    matches.push(match);
    for (const token of span(match)) taken.add(token);
    at += match.length - 1;
  }
  const unreadCues = unreadPriceCues(text, tokens, taken);
  const of = <K extends Entry["kind"]>(kind: K) => matches.filter((match): match is Match & { entry: Extract<Entry, { kind: K }> } => match.entry.kind === kind);

  // What: one category (and subcategory) for every thing named, else nothing.
  const flags = { rent: of("rent").length > 0, sale: of("sale").length > 0, holiday: of("holiday").length > 0 };
  const things = of("thing").filter((match) => !match.entry.weak || flags.rent || flags.sale || flags.holiday);
  const resolved = things.map((match) => resolveThing(match.entry, flags));
  let target: Resolved | null = null;
  if (resolved.length > 0 && resolved.every((each) => each !== null)) {
    const categories = new Set(resolved.map((each) => each?.category));
    const subcategories = new Set(resolved.flatMap((each) => (each?.subcategory ? [each.subcategory] : [])));
    if (categories.size === 1 && subcategories.size <= 1) {
      const criteria: Record<string, string[]> = {};
      for (const each of resolved) for (const [id, values] of Object.entries(each?.criteria ?? {})) criteria[id] = [...new Set([...(criteria[id] ?? []), ...values])];
      target = { category: [...categories][0] ?? "", ...(subcategories.size ? { subcategory: [...subcategories][0] } : {}), criteria };
    }
  }
  // "location saisonnière", "location vacances" with nothing named: a holiday rental (journey review 2026-10-29).
  const holidayAlone = !target && things.length === 0 && flags.holiday;
  if (holidayAlone) target = { category: "immobilier", subcategory: "location-vacances", criteria: {} };
  if (target) {
    const families = new Set(things.map((match) => match.entry.family));
    const used = [
      ...things,
      ...of("sale"),
      ...(families.has("car") || families.has("property") ? of("rent") : []),
      ...(families.has("property") || holidayAlone ? of("holiday") : []),
    ];
    const tokensOf = used.flatMap(span);
    understood.push({ key: "category", label: labelOf(tokens, tokensOf), patch: { category: target.category, ...(target.subcategory ? { subcategory: target.subcategory } : {}) }, tokens: tokensOf, content: true });
    for (const [id, values] of Object.entries(target.criteria)) {
      understood.push({ key: `criterion:${id}`, label: labelOf(tokens, tokensOf), patch: { criteria: { [id]: { kind: "options", values } } }, tokens: [], content: true, needsCategory: true });
    }
    // Modifiers that fit the subcategory ("enfant" with a bike); the others stay words.
    for (const match of of("modifier")) {
      const option = target.subcategory ? match.entry.options[target.subcategory] : undefined;
      if (!option) continue;
      const [id, value] = option;
      const existing = understood.find((item) => item.key === `criterion:${id}`);
      const filter = existing?.patch.criteria?.[id];
      if (existing && filter?.kind === "options") {
        filter.values = [...new Set([...filter.values, value])];
        existing.tokens = [...existing.tokens, ...span(match)];
        existing.label = labelOf(tokens, [...existing.tokens, ...span(match)]);
      } else {
        understood.push({ key: `criterion:${id}`, label: labelOf(tokens, span(match)), patch: { criteria: { [id]: { kind: "options", values: [value] } } }, tokens: span(match), content: true, needsCategory: true });
      }
    }
  }

  // Where.
  const cities = new Set(of("city").map((match) => match.entry.slug));
  if (cities.size === 1) {
    const indices = of("city").flatMap(span);
    understood.push({ key: "location", label: labelOf(tokens, indices), patch: { city: [...cities][0] }, tokens: indices, content: true });
  }

  // How much.
  const prices = amounts.filter((match) => match.kind === "price");
  if (prices.length > 0) {
    const mins = prices.flatMap((match) => (match.min === undefined ? [] : [match.min]));
    const maxes = prices.flatMap((match) => (match.max === undefined ? [] : [match.max]));
    const min = mins.length ? Math.max(...mins) : undefined;
    const max = maxes.length ? Math.min(...maxes) : undefined;
    const indices = prices.flatMap((match) => match.tokens);
    if (min === undefined || max === undefined || min <= max) {
      understood.push({ key: "price", label: labelOf(tokens, indices), patch: { ...(min !== undefined ? { priceMin: min } : {}), ...(max !== undefined ? { priceMax: max } : {}) }, tokens: indices, content: false });
    } else dropped.push(...indices);
  }

  // Condition: only where listings always state it; a word of meaning ("neuf") stays otherwise.
  const conditionMatches = of("conditions");
  if (conditionMatches.length > 0) {
    const indices = conditionMatches.flatMap(span);
    if (conditionApplies(target)) {
      const values = [...new Set(conditionMatches.flatMap((match) => match.entry.values))] as Condition[];
      understood.push({ key: "conditions", label: labelOf(tokens, indices), patch: { conditions: values }, tokens: indices, content: false });
    } else if (!conditionMatches.some((match) => match.entry.keepWhenIdle)) dropped.push(...indices);
  }

  const flag = (kind: "donation" | "photo", key: "donation" | "withPhoto", patch: SearchParams) => {
    const found = of(kind);
    if (found.length === 0) return;
    const indices = found.flatMap(span);
    understood.push({ key, label: labelOf(tokens, indices), patch, tokens: indices, content: false });
  };
  flag("donation", "donation", { donation: true });
  flag("photo", "withPhoto", { withPhoto: true });

  const sellers = new Set(of("seller").map((match) => match.entry.type));
  if (sellers.size === 1) {
    const indices = of("seller").flatMap(span);
    understood.push({ key: "sellerType", label: labelOf(tokens, indices), patch: { sellerType: [...sellers][0] as SellerTypeFilter }, tokens: indices, content: false });
  } else if (sellers.size > 1) dropped.push(...of("seller").flatMap(span));

  if (of("cheap").length > 0) {
    const indices = of("cheap").flatMap(span);
    understood.push({ key: "sort", label: labelOf(tokens, indices), patch: { sort: "price_asc" satisfies SearchSort }, tokens: indices, content: false });
  }

  // Near the visitor: « à côté », « qrib », or a distance alone ("à 2 km").
  const distances = amounts.filter((match) => match.kind === "distance");
  const near = of("near");
  if (near.length > 0 || distances.length > 0) {
    const indices = [...near.flatMap(span), ...distances.flatMap((match) => match.tokens)];
    const km = distances.length ? Math.min(...distances.map((match) => match.km)) : NEAR_KM;
    understood.push({ key: "near", label: labelOf(tokens, indices), patch: {}, tokens: indices, content: false, km });
  }

  understood.sort((a, b) => rank(a.key) - rank(b.key));
  const interpretation: Interpretation = { text, tokens, understood, dropped, unreadCues, patch: {}, q: text };
  const all = build(interpretation, {}, new Set(understood));
  interpretation.q = all.q ?? "";
  interpretation.patch = canonicalSearchParams({ ...all, q: undefined });
  return interpretation;
}

// ---- Applying an interpretation to a URL.

function mergeCriteria(a: Record<string, CriterionFilter> | undefined, b: Record<string, CriterionFilter> | undefined): Record<string, CriterionFilter> | undefined {
  if (!a && !b) return undefined;
  return { ...a, ...b };
}

/** The words left: those no applied item (or a dropped word) consumed, fillers and unread price words out once anything was. */
function residual(interpretation: Interpretation, accepted: ReadonlySet<Understood>): string {
  const consumed = new Set<number>(interpretation.dropped);
  for (const item of interpretation.understood) if (!item.content || accepted.has(item)) for (const token of item.tokens) consumed.add(token);
  if (consumed.size === 0) return interpretation.text;
  const unread = new Set(interpretation.unreadCues);
  return keptText(interpretation.text, interpretation.tokens, (at) => !consumed.has(at) && !unread.has(at) && !FILLER_WORDS.has(interpretation.tokens[at]?.norm ?? ""));
}

/** URL filters + the accepted items, words left as `q`; canonical. */
function build(interpretation: Interpretation, url: SearchParams, accepted: ReadonlySet<Understood>): SearchParams {
  let params: SearchParams = { ...url };
  for (const item of interpretation.understood) {
    if (!accepted.has(item)) continue;
    const { criteria, ...patch } = item.patch;
    params = { ...params, ...patch, ...(criteria ? { criteria: mergeCriteria(params.criteria, criteria) } : {}) };
  }
  const q = residual(interpretation, accepted);
  params.q = q || undefined;
  if (!params.q) delete params.q;
  return canonicalSearchParams(params);
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Whether the URL leaves room for the item (unset, or set to the same value). */
function fits(item: Understood, url: SearchParams): boolean {
  const patch = item.patch;
  switch (true) {
    case item.key === "category":
      if (url.subcategory) return url.subcategory === patch.subcategory || (!patch.subcategory && url.category === patch.category);
      return !url.category || url.category === patch.category;
    case item.key.startsWith("criterion:"): {
      const id = item.key.slice("criterion:".length);
      const current = url.criteria?.[id];
      return !current || JSON.stringify(current) === JSON.stringify(patch.criteria?.[id]);
    }
    case item.key === "location":
      return url.city ? url.city === patch.city : !url.region && !url.zone;
    case item.key === "price":
      return (url.priceMin === undefined && url.priceMax === undefined) || (url.priceMin === patch.priceMin && url.priceMax === patch.priceMax);
    case item.key === "conditions":
      return !url.conditions || sameList(url.conditions, patch.conditions);
    case item.key === "sellerType":
      return !url.shop && (!url.sellerType || url.sellerType === patch.sellerType);
    case item.key === "sort":
      return !url.sort || url.sort === patch.sort;
    case item.key === "near":
      return !url.city && !url.region;
    default:
      return true;
  }
}

/** Whether the canonical parameters kept what the item set (a criterion of another subcategory goes). */
function survives(item: Understood, params: SearchParams): boolean {
  const patch = item.patch;
  if (item.key === "category") return params.category === patch.category && (!patch.subcategory || params.subcategory === patch.subcategory);
  if (item.key.startsWith("criterion:")) return params.criteria?.[item.key.slice("criterion:".length)] !== undefined;
  if (item.key === "location") return params.city === patch.city;
  if (item.key === "price") return params.priceMin === patch.priceMin && params.priceMax === patch.priceMax;
  if (item.key === "conditions") return sameList(params.conditions, patch.conditions);
  if (item.key === "donation") return params.donation === true;
  if (item.key === "withPhoto") return params.withPhoto === true;
  if (item.key === "sellerType") return params.sellerType === patch.sellerType;
  if (item.key === "sort") return effectiveSort(params) === patch.sort;
  return true;
}

export interface AppliedItem {
  key: UnderstoodKey;
  /** The words it came from. */
  words: string;
  /** The search without it, the words not interpreted again (`raw`). */
  without: SearchParams;
}

export interface AppliedNear {
  /**
   * "ask": the page offers « Utiliser ma position »; "zone": the URL already holds the visitor's
   * circle (`fromPosition`). A map area of the URL is not the visitor's: still "ask".
   */
  state: "ask" | "zone";
  km: number;
  /** The search to run with the visitor's circle as `zone` (the sentence kept: its items stay understood). */
  target: SearchParams;
}

export interface AppliedSearch {
  /** What to search: URL filters, understood filters, words left. */
  params: SearchParams;
  /** Understood and applied, in display order. */
  items: AppliedItem[];
  near?: AppliedNear;
  /** The typed words searched as they are, URL filters kept. */
  exact: SearchParams;
}

/**
 * The URL search with its words interpreted, or null when nothing was understood (search the URL
 * as it is). `url` is the parsed URL query; a `raw` URL is never interpreted (the caller checks).
 */
export function applyInterpretation(url: SearchParams, interpretation: Interpretation): AppliedSearch | null {
  if (interpretation.understood.length === 0) return null;
  const accepted = new Set(interpretation.understood.filter((item) => fits(item, url)));
  const category = interpretation.understood.find((item) => item.key === "category");
  const prune = () => {
    for (const item of accepted) if (item.needsCategory && (!category || !accepted.has(category))) accepted.delete(item);
  };
  prune();
  let params = build(interpretation, url, accepted);
  // Items the canonical form dropped (a criterion another subcategory has not) leave too.
  for (let pass = 0; pass < 3; pass += 1) {
    const lost = [...accepted].filter((item) => !survives(item, params));
    if (lost.length === 0) break;
    for (const item of lost) accepted.delete(item);
    prune();
    params = build(interpretation, url, accepted);
  }
  const without = (item: Understood): SearchParams => {
    const rest = new Set(accepted);
    rest.delete(item);
    if (item === category) for (const each of rest) if (each.needsCategory) rest.delete(each);
    return canonicalSearchParams({ ...build(interpretation, url, rest), raw: true });
  };
  const items: AppliedItem[] = [];
  let near: AppliedNear | undefined;
  for (const item of interpretation.understood) {
    if (!accepted.has(item)) continue;
    if (item.key === "near") {
      const zone = url.zone && url.fromPosition ? url.zone : undefined;
      near = { state: zone ? "zone" : "ask", km: zone?.km ?? item.km ?? NEAR_KM, target: canonicalSearchParams({ ...url, raw: undefined }) };
      const rest = { ...params, raw: true as const };
      if (zone) delete rest.zone;
      items.push({ key: "near", words: item.label, without: canonicalSearchParams(rest) });
      continue;
    }
    items.push({ key: item.key, words: item.label, without: without(item) });
  }
  if (items.length === 0) return null;
  return { params, items, ...(near ? { near } : {}), exact: canonicalSearchParams({ ...url, raw: true }) };
}

/** The interpreted search of a URL query with words (`raw` excepted); null to search it as it is. */
export function interpretSearch(url: SearchParams): AppliedSearch | null {
  if (!url.q || url.raw) return null;
  return applyInterpretation(url, interpretQuery(url.q));
}
