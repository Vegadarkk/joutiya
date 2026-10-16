import { normalizeText } from "@/lib/text/normalize";
import { assertFacets, assertFilter } from "./filters";
import { foldDigits } from "./normalize";
import { MAX_VALUES_PER_FACET, SEARCHABLE_ATTRIBUTES, SEARCH_SETTINGS, STOP_WORDS } from "./settings";
import { CARD_FIELDS, type EngineQuery, type EngineResult, type FilterExpr, type FilterValue, type SearchDocument, type SearchEngine, type SortSpec } from "./types";

// In-memory SearchEngine (design D1): development without Meilisearch, unit and API tests. It follows
// the Meilisearch behaviour the app relies on, checked by the shared contract suite (tests/search):
// - text: case, accent and Arabic-letter folding (normalizeText), Arabic article split off and
//   dropped (stop word), every query word must match a word of a searchable field (matchingStrategy
//   "all") or the first ones ("last"); the last word also matches as a prefix; typos as configured
//   (1 from 5 letters, 2 from 9, a wrong first letter costs 2, none on numbers); two adjacent
//   document words also match written together ("tshirt" finds "t-shirt"); synonyms (one to three
//   words) match as phrases. Only the first 10 query words count. No proximity rule.
// - ranking: matched words, then the requested sort, then typos, attribute order, exactness,
//   then sortAt desc; documents missing a sort field come last.
// - filters (same validation as the Meilisearch adapter), facets, page mode (totalHits exhaustive,
//   pages limited to pagination.maxTotalHits), documents/versions iteration in insertion order.

const MAX_QUERY_WORDS = 10;
const ARTICLE = "ال";
const STOP = new Set<string>(STOP_WORDS);
const EARTH_RADIUS_M = 6_371_000;
const ARABIC = /[؀-ۿ]/;

/** Words of a text as the engine indexes them (folded, article split, stop words dropped). */
export function searchTokens(text: string): string[] {
  const words = normalizeText(foldDigits(text).replace(/['’`´]/g, " "));
  if (!words) return [];
  const out: string[] = [];
  for (const word of words.split(" ")) {
    const bare = word.length > ARTICLE.length && word.startsWith(ARTICLE) ? word.slice(ARTICLE.length) : word;
    if (!STOP.has(bare)) out.push(bare);
  }
  return out;
}

interface Prepared {
  doc: SearchDocument;
  /** Tokens per searchable attribute (SEARCHABLE_ATTRIBUTES order). */
  fields: string[][];
  /** Two adjacent tokens written together, per attribute (exact matches only). */
  joined: Set<string>[];
  seq: number;
}

interface Term {
  /** Each alternative is a phrase (token list); index 0 is the typed word(s). */
  alternatives: string[][];
  /** Prefix and typo matching apply to the typed word only. */
  last: boolean;
}

interface TermMatch {
  typos: number;
  attribute: number;
  exact: boolean;
}

export interface MemoryEngineOptions {
  /** Meilisearch-style synonyms (term -> other terms); default SEARCH_SETTINGS.synonyms. */
  synonyms?: Readonly<Record<string, readonly string[]>>;
}

function typoBudget(word: string): number {
  if (/^\d+$/.test(word) && SEARCH_SETTINGS.typoTolerance.disableOnNumbers) return 0;
  const { oneTypo, twoTypos } = SEARCH_SETTINGS.typoTolerance.minWordSizeForTypos;
  const length = [...word].length;
  return length >= twoTypos ? 2 : length >= oneTypo ? 1 : 0;
}

/** Optimal-string-alignment distance; with `prefix`, the distance to the closest prefix of `b`. */
function distance(a: string, b: string, prefix: boolean, limit: number): number {
  const x = [...a];
  const y = [...b];
  if (!prefix && Math.abs(x.length - y.length) > limit) return limit + 1;
  const rows: number[][] = [Array.from({ length: y.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let value = Math.min((rows[i - 1]?.[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (rows[i - 1]?.[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) value = Math.min(value, (rows[i - 2]?.[j - 2] ?? 0) + 1);
      row.push(value);
    }
    rows.push(row);
  }
  const lastRow = rows[x.length] ?? [];
  return prefix ? Math.min(...lastRow) : (lastRow[y.length] ?? limit + 1);
}

/** Typos needed for `word` to match `token` (prefix allowed for the last query word), or undefined. */
function wordMatch(word: string, token: string, prefix: boolean): number | undefined {
  if (word === token) return 0;
  if (prefix && token.startsWith(word)) return 0;
  const budget = typoBudget(word);
  if (budget === 0) return undefined;
  // A wrong first letter counts as two typos (Meilisearch).
  const firstPenalty = word[0] === token[0] ? 0 : 1;
  const typos = distance(word, token, prefix, budget) + firstPenalty;
  return typos <= budget ? typos : undefined;
}

function phraseAt(tokens: readonly string[], phrase: readonly string[]): boolean {
  outer: for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    for (let k = 0; k < phrase.length; k += 1) if (tokens[start + k] !== phrase[k]) continue outer;
    return true;
  }
  return false;
}

function matchTerm(term: Term, prepared: Prepared): TermMatch | undefined {
  let best: TermMatch | undefined;
  const consider = (match: TermMatch) => {
    if (!best || match.typos < best.typos || (match.typos === best.typos && match.attribute < best.attribute)) best = match;
  };
  term.alternatives.forEach((phrase, index) => {
    prepared.fields.forEach((tokens, attribute) => {
      if (phrase.length > 1) {
        if (phraseAt(tokens, phrase)) consider({ typos: 0, attribute, exact: index === 0 });
        return;
      }
      const word = phrase[0] ?? "";
      if (index > 0) {
        if (tokens.includes(word)) consider({ typos: 0, attribute, exact: false });
        return;
      }
      if (prepared.joined[attribute]?.has(word)) consider({ typos: 0, attribute, exact: false });
      for (const token of tokens) {
        const typos = wordMatch(word, token, term.last);
        if (typos !== undefined) consider({ typos, attribute, exact: typos === 0 && token === word });
      }
    });
  });
  return best;
}

function valueEquals(stored: unknown, wanted: FilterValue): boolean {
  if (typeof stored === "number") return typeof wanted === "boolean" ? false : Number(wanted) === stored;
  if (typeof stored === "boolean") return wanted === stored || String(wanted).toLowerCase() === String(stored);
  if (typeof stored === "string") return stored.toLowerCase() === String(wanted).toLowerCase();
  return false;
}

function values(stored: unknown): unknown[] {
  return Array.isArray(stored) ? stored : stored === undefined || stored === null ? [] : [stored];
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Evaluates a (validated) filter on one document. */
export function matchesFilter(doc: SearchDocument, expr: FilterExpr): boolean {
  if ("and" in expr) return expr.and.every((part) => matchesFilter(doc, part));
  if ("or" in expr) return expr.or.some((part) => matchesFilter(doc, part));
  if ("not" in expr) return !matchesFilter(doc, expr.not);
  if ("geoRadius" in expr) return doc._geo !== undefined && haversineMeters(doc._geo, expr.geoRadius) <= Math.round(expr.geoRadius.meters);
  const stored = (doc as unknown as Record<string, unknown>)[expr.field];
  switch (expr.op) {
    case "eq":
      return values(stored).some((value) => valueEquals(value, expr.value));
    case "in":
      return values(stored).some((value) => expr.values.some((wanted) => valueEquals(value, wanted)));
    case "exists":
      return stored !== undefined;
    case "gt":
      return values(stored).some((value) => typeof value === "number" && value > expr.value);
    case "gte":
      return values(stored).some((value) => typeof value === "number" && value >= expr.value);
    case "lt":
      return values(stored).some((value) => typeof value === "number" && value < expr.value);
    case "lte":
      return values(stored).some((value) => typeof value === "number" && value <= expr.value);
  }
}

function pick<T>(doc: SearchDocument, fields: readonly string[]): T {
  const source = doc as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (source[field] !== undefined) out[field] = structuredClone(source[field]);
  return out as T;
}

function sortValue(doc: SearchDocument, spec: SortSpec): number | undefined {
  if ("geoPoint" in spec) return doc._geo ? haversineMeters(doc._geo, spec.geoPoint) : undefined;
  const value = doc[spec.field];
  return typeof value === "number" ? value : undefined;
}

function compareSort(a: SearchDocument, b: SearchDocument, sort: readonly SortSpec[]): number {
  for (const spec of sort) {
    const x = sortValue(a, spec);
    const y = sortValue(b, spec);
    if (x === y) continue;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return spec.dir === "asc" ? x - y : y - x;
  }
  return 0;
}

function facetKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export class MemoryEngine implements SearchEngine {
  readonly kind = "memory" as const;
  private readonly store = new Map<string, Prepared>();
  private readonly synonyms = new Map<string, string[][]>();
  private seq = 0;

  constructor(options: MemoryEngineOptions = {}) {
    for (const [term, others] of Object.entries(options.synonyms ?? SEARCH_SETTINGS.synonyms)) {
      const tokens = searchTokens(term);
      // Meilisearch 1.55.0 does not trigger multi-word Arabic keys (normalizeQuery rewrites those
      // phrases): skip them so development matches production.
      if (tokens.length === 0 || (tokens.length > 1 && ARABIC.test(term))) continue;
      const key = tokens.join(" ");
      const list = this.synonyms.get(key) ?? [];
      for (const other of others) {
        const phrase = searchTokens(other);
        if (phrase.length && !list.some((known) => known.join(" ") === phrase.join(" "))) list.push(phrase);
      }
      this.synonyms.set(key, list);
    }
  }

  /** Number of stored documents. */
  get size(): number {
    return this.store.size;
  }

  /** Tests: forget every document. */
  clear(): void {
    this.store.clear();
  }

  async search(queries: EngineQuery[]): Promise<EngineResult[]> {
    return queries.map((query) => this.run(query));
  }

  async upsert(documents: SearchDocument[]): Promise<void> {
    for (const doc of documents) {
      if (!doc.id) throw new Error("document without id");
      const copy = structuredClone(doc);
      const fields = SEARCHABLE_ATTRIBUTES.map((attribute) => searchTokens(typeof copy[attribute] === "string" ? copy[attribute] : ""));
      const joined = fields.map((tokens) => new Set(tokens.slice(1).map((token, i) => `${tokens[i] ?? ""}${token}`)));
      const existing = this.store.get(doc.id);
      this.store.set(doc.id, { doc: copy, fields, joined, seq: existing?.seq ?? (this.seq += 1) });
    }
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.store.delete(id);
  }

  async *versions(): AsyncIterable<{ id: string; version: number }[]> {
    for await (const page of this.documents<Pick<SearchDocument, "id" | "version">>({ fields: ["id", "version"] })) {
      yield page.map((doc) => ({ id: doc.id, version: doc.version }));
    }
  }

  async *documents<T extends Partial<SearchDocument>>(options: { filter?: FilterExpr; fields: readonly (keyof SearchDocument)[]; pageSize?: number; max?: number }): AsyncIterable<T[]> {
    if (options.filter) assertFilter(options.filter);
    const pageSize = Math.max(1, options.pageSize ?? 1000);
    let remaining = options.max ?? Number.POSITIVE_INFINITY;
    let page: T[] = [];
    for (const { doc } of [...this.store.values()]) {
      if (remaining <= 0) break;
      if (options.filter && !matchesFilter(doc, options.filter)) continue;
      page.push(pick<T>(doc, options.fields as readonly string[]));
      remaining -= 1;
      if (page.length === pageSize) {
        yield page;
        page = [];
      }
    }
    if (page.length) yield page;
  }

  async ensureReady(): Promise<{ created: boolean; settingsUpdated: boolean }> {
    return { created: false, settingsUpdated: false };
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  private terms(q: string): Term[] | undefined {
    const raw = normalizeText(foldDigits(q).replace(/['’`´]/g, " "));
    if (!raw) return undefined;
    const words = searchTokens(q).slice(0, MAX_QUERY_WORDS);
    const terms: Term[] = [];
    let i = 0;
    while (i < words.length) {
      let taken = 1;
      let alternatives: string[][] = [[words[i] ?? ""]];
      // Longest synonym phrase first (Meilisearch: up to 3 words).
      for (let size = Math.min(3, words.length - i); size >= 1; size -= 1) {
        const phrase = words.slice(i, i + size);
        const others = this.synonyms.get(phrase.join(" "));
        if (others) {
          taken = size;
          alternatives = [phrase, ...others];
          break;
        }
      }
      terms.push({ alternatives, last: i + taken === words.length && taken === 1 });
      i += taken;
    }
    return terms;
  }

  private run(query: EngineQuery): EngineResult {
    const started = performance.now();
    if (!Number.isInteger(query.page) || query.page < 1) throw new RangeError("page must be a positive integer");
    if (!Number.isInteger(query.hitsPerPage) || query.hitsPerPage < 0) throw new RangeError("hitsPerPage must be a non-negative integer");
    if (query.filter) assertFilter(query.filter);
    if (query.facets) assertFacets(query.facets);
    const sort = query.sort ?? [];
    const terms = this.terms(query.q);
    const strategy = query.matchingStrategy ?? "all";

    type Ranked = { prepared: Prepared; words: number; typos: number; attribute: number; exact: number };
    const ranked: Ranked[] = [];
    for (const prepared of this.store.values()) {
      if (query.filter && !matchesFilter(prepared.doc, query.filter)) continue;
      if (terms === undefined) {
        ranked.push({ prepared, words: 0, typos: 0, attribute: 0, exact: 0 });
        continue;
      }
      let words = 0;
      let typos = 0;
      let attribute = 0;
      let exact = 0;
      for (const term of terms) {
        const match = matchTerm(term, prepared);
        if (!match) break;
        words += 1;
        typos += match.typos;
        attribute += match.attribute;
        if (match.exact) exact += 1;
      }
      const enough = strategy === "all" ? words === terms.length && words > 0 : words > 0;
      if (enough) ranked.push({ prepared, words, typos, attribute, exact });
    }
    ranked.sort(
      (a, b) =>
        b.words - a.words ||
        compareSort(a.prepared.doc, b.prepared.doc, sort) ||
        a.typos - b.typos ||
        a.attribute - b.attribute ||
        b.exact - a.exact ||
        compareSort(a.prepared.doc, b.prepared.doc, [{ field: "sortAt", dir: "desc" }]) ||
        a.prepared.seq - b.prepared.seq,
    );

    const facetDistribution: Record<string, Record<string, number>> = {};
    for (const facet of query.facets ?? []) {
      const counts = new Map<string, number>();
      for (const { prepared } of ranked) {
        for (const value of values((prepared.doc as unknown as Record<string, unknown>)[facet])) {
          const key = facetKey(value);
          if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const sorted = [...counts].sort(([ka, a], [kb, b]) => b - a || (ka < kb ? -1 : ka > kb ? 1 : 0)).slice(0, MAX_VALUES_PER_FACET);
      facetDistribution[facet] = Object.fromEntries(sorted);
    }

    const maxTotalHits = SEARCH_SETTINGS.pagination.maxTotalHits;
    const reachable = Math.min(ranked.length, maxTotalHits);
    const start = (query.page - 1) * query.hitsPerPage;
    const end = Math.min(start + query.hitsPerPage, reachable);
    const fields = query.fields ?? CARD_FIELDS;
    const hits = start < end ? ranked.slice(start, end).map(({ prepared }) => pick<EngineResult["hits"][number]>(prepared.doc, fields)) : [];
    return {
      hits,
      totalHits: ranked.length,
      totalPages: query.hitsPerPage > 0 ? Math.ceil(reachable / query.hitsPerPage) : 0,
      page: query.page,
      ...(query.facets ? { facetDistribution } : {}),
      processingTimeMs: Math.round(performance.now() - started),
    };
  }
}
