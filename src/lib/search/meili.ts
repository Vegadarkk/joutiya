import { z } from "@/lib/zod";
import { assertFacets, toMeiliFilter } from "./filters";
import { SEARCH_SETTINGS, settingsDiff, type IndexSettings } from "./settings";
import { CARD_FIELDS, SEARCH_INDEX, SearchUnavailableError, type EngineQuery, type EngineResult, type FilterExpr, type SearchDocument, type SearchEngine, type SortSpec } from "./types";

// Meilisearch adapter (design D1, D3): a thin fetch client over the REST API of v1.55.0 (no npm
// dependency; every shape below was checked against a local container). Reads (multi-search,
// documents fetch) use the search key (`search`, `documents.get`); writes, settings and tasks use
// the indexing key. Unreachable server, timeouts, 5xx, a rejected key or a missing index raise
// SearchUnavailableError (503 `search_unavailable`); any other 4xx is a bug and raises MeiliError.
// Writes resolve once their task succeeded. No import of server-only modules: scripts use it too.

export interface MeiliEngineOptions {
  url: string;
  /** `search` + `documents.get` on listings_* (web, alerts). */
  searchKey?: string;
  /** documents.*, indexes.*, settings.*, tasks.get, stats.get on listings_* (worker, scripts). */
  indexKey?: string;
  /** Index uid; default SEARCH_INDEX. */
  index?: string;
  /** Search and documents requests (ms). */
  readTimeoutMs?: number;
  /** Other requests (ms). */
  writeTimeoutMs?: number;
  /** Longest wait for one task, e.g. a settings change re-indexing everything (ms). */
  taskTimeoutMs?: number;
  /** Tests: replaces the global fetch. */
  fetch?: typeof fetch;
}

/** Meilisearch answered a 4xx that is not an availability problem (bad request: a bug). */
export class MeiliError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  // No parameter properties: scripts load this file with Node's type stripping.
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "MeiliError";
    this.status = status;
    this.code = code;
  }
}

const errorBody = z.object({ message: z.string().optional(), code: z.string().optional() }).passthrough();
const taskRef = z.object({ taskUid: z.number().int() }).passthrough();
const task = z
  .object({
    uid: z.number().int(),
    status: z.enum(["enqueued", "processing", "succeeded", "failed", "canceled"]),
    type: z.string(),
    error: z.object({ message: z.string(), code: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough();
export type MeiliTask = z.infer<typeof task>;
const searchResult = z
  .object({
    hits: z.array(z.record(z.string(), z.unknown())),
    totalHits: z.number().int(),
    page: z.number().int(),
    processingTimeMs: z.number(),
    facetDistribution: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  })
  .passthrough();
const multiSearch = z.object({ results: z.array(searchResult) }).passthrough();
const documentsPage = z.object({ results: z.array(z.record(z.string(), z.unknown())), total: z.number().int() }).passthrough();
const stats = z.object({ numberOfDocuments: z.number().int(), isIndexing: z.boolean() }).passthrough();

/** Codes meaning "search is not available" rather than "the request is wrong". */
const UNAVAILABLE_CODES = new Set(["index_not_found", "invalid_api_key", "missing_authorization_header"]);

const DOCUMENT_BATCH = 5000;
const DEFAULT_PAGE = 1000;

function sortString(spec: SortSpec): string {
  if ("geoPoint" in spec) {
    const { lat, lng } = spec.geoPoint;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RangeError("geoPoint: not a finite point");
    return `_geoPoint(${lat},${lng}):asc`;
  }
  return `${spec.field}:${spec.dir}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MeiliEngine implements SearchEngine {
  readonly kind = "meili" as const;
  readonly index: string;
  private readonly url: string;
  private readonly options: MeiliEngineOptions;
  private readonly fetcher: typeof fetch;
  private ready: Promise<unknown> | undefined;

  constructor(options: MeiliEngineOptions) {
    this.options = options;
    this.url = options.url.replace(/\/+$/, "");
    this.index = options.index ?? SEARCH_INDEX;
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(this.index)) throw new RangeError("invalid index uid");
    this.fetcher = options.fetch ?? fetch;
  }

  /** Same server and keys, another index (rebuilds fill `listings_v2` then swap). */
  withIndex(index: string): MeiliEngine {
    return new MeiliEngine({ ...this.options, index });
  }

  // ---- HTTP

  private key(kind: "search" | "read" | "write"): string {
    const key = kind === "search" ? this.options.searchKey : kind === "read" ? (this.options.searchKey ?? this.options.indexKey) : this.options.indexKey;
    if (!key) throw new SearchUnavailableError(`meilisearch ${kind === "write" ? "indexing" : "search"} key is not configured`);
    return key;
  }

  private async request(method: string, path: string, init: { key?: string; body?: unknown; timeoutMs: number }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method,
        headers: { ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      throw new SearchUnavailableError(`meilisearch unreachable (${method} ${path.split("?")[0]})`, { cause: error });
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new SearchUnavailableError("meilisearch response interrupted", { cause: error });
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (response.ok) return body;
    const parsed = errorBody.safeParse(body);
    const code = parsed.success ? parsed.data.code : undefined;
    const message = `meilisearch ${response.status}${code ? ` ${code}` : ""}: ${(parsed.success && parsed.data.message) || response.statusText}`;
    if (response.status >= 500 || response.status === 429 || (code !== undefined && UNAVAILABLE_CODES.has(code)) || response.status === 401 || response.status === 403) {
      throw new SearchUnavailableError(message);
    }
    throw new MeiliError(response.status, code, message);
  }

  private read(method: string, path: string, body?: unknown, key = this.key("read")): Promise<unknown> {
    return this.request(method, path, { key, body, timeoutMs: this.options.readTimeoutMs ?? 2000 });
  }

  private write(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, { key: this.key("write"), body, timeoutMs: this.options.writeTimeoutMs ?? 15_000 });
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new SearchUnavailableError(`unexpected meilisearch ${what} response`);
    return result.data;
  }

  private get indexPath(): string {
    return `/indexes/${encodeURIComponent(this.index)}`;
  }

  /** Polls a task (50 ms doubling to 1 s) until it finishes; throws MeiliError when it failed. */
  async waitForTask(taskUid: number, timeoutMs = this.options.taskTimeoutMs ?? 120_000): Promise<MeiliTask> {
    const deadline = Date.now() + timeoutMs;
    let delay = 50;
    for (;;) {
      const current = this.parse(task, await this.write("GET", `/tasks/${taskUid}`), "task");
      if (current.status === "succeeded") return current;
      if (current.status === "failed" || current.status === "canceled") {
        throw new MeiliError(400, current.error?.code, `meilisearch task ${taskUid} (${current.type}) ${current.status}: ${current.error?.message ?? "no detail"}`);
      }
      if (Date.now() > deadline) throw new SearchUnavailableError(`meilisearch task ${taskUid} still ${current.status} after ${timeoutMs} ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }

  private async writeTask(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<MeiliTask> {
    const { taskUid } = this.parse(taskRef, await this.write(method, path, body), "task reference");
    return this.waitForTask(taskUid, timeoutMs);
  }

  // ---- SearchEngine

  async search(queries: EngineQuery[]): Promise<EngineResult[]> {
    if (queries.length === 0) return [];
    const payload = queries.map((query) => {
      if (!Number.isInteger(query.page) || query.page < 1) throw new RangeError("page must be a positive integer");
      if (!Number.isInteger(query.hitsPerPage) || query.hitsPerPage < 0) throw new RangeError("hitsPerPage must be a non-negative integer");
      if (query.facets) assertFacets(query.facets);
      const filter = query.filter ? toMeiliFilter(query.filter) : "";
      return {
        indexUid: this.index,
        q: query.q,
        ...(filter ? { filter } : {}),
        ...(query.sort?.length ? { sort: query.sort.map(sortString) } : {}),
        page: query.page,
        hitsPerPage: query.hitsPerPage,
        ...(query.facets?.length ? { facets: query.facets } : {}),
        matchingStrategy: query.matchingStrategy ?? "all",
        attributesToRetrieve: [...(query.fields ?? CARD_FIELDS)],
      };
    });
    const { results } = this.parse(multiSearch, await this.read("POST", "/multi-search", { queries: payload }, this.key("search")), "multi-search");
    const maxTotalHits = SEARCH_SETTINGS.pagination.maxTotalHits;
    return results.map((result, i) => {
      const hitsPerPage = queries[i]?.hitsPerPage ?? 0;
      // Meilisearch reports the exhaustive totalHits but serves pages only up to maxTotalHits.
      const reachable = Math.min(result.totalHits, maxTotalHits);
      return {
        hits: result.hits as unknown as EngineResult["hits"],
        totalHits: result.totalHits,
        totalPages: hitsPerPage > 0 ? Math.ceil(reachable / hitsPerPage) : 0,
        page: result.page,
        ...(result.facetDistribution ? { facetDistribution: result.facetDistribution } : {}),
        processingTimeMs: result.processingTimeMs,
      };
    });
  }

  /** Lazily makes sure the index exists with its settings before the first write of this process. */
  private ensureReadyOnce(): Promise<unknown> {
    this.ready ??= this.ensureReady().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async upsert(documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    // A document write on a missing index would create it without settings (skipCreation does not
    // prevent it on 1.55.0): create and configure it first.
    await this.ensureReadyOnce();
    for (let i = 0; i < documents.length; i += DOCUMENT_BATCH) {
      await this.writeTask("POST", `${this.indexPath}/documents?primaryKey=id`, documents.slice(i, i + DOCUMENT_BATCH));
    }
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureReadyOnce();
    for (let i = 0; i < ids.length; i += DOCUMENT_BATCH) {
      await this.writeTask("POST", `${this.indexPath}/documents/delete-batch`, ids.slice(i, i + DOCUMENT_BATCH));
    }
  }

  async *versions(): AsyncIterable<{ id: string; version: number }[]> {
    for await (const page of this.documents<Pick<SearchDocument, "id" | "version">>({ fields: ["id", "version"] })) {
      yield page.map((doc) => ({ id: String(doc.id), version: Number(doc.version) }));
    }
  }

  async *documents<T extends Partial<SearchDocument>>(options: { filter?: FilterExpr; fields: readonly (keyof SearchDocument)[]; pageSize?: number; max?: number }): AsyncIterable<T[]> {
    const filter = options.filter ? toMeiliFilter(options.filter) : "";
    const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE, 10_000));
    const max = options.max ?? Number.POSITIVE_INFINITY;
    let offset = 0;
    while (offset < max) {
      const limit = Math.min(pageSize, max - offset);
      const page = this.parse(
        documentsPage,
        await this.read("POST", `${this.indexPath}/documents/fetch`, { ...(filter ? { filter } : {}), fields: [...options.fields], offset, limit }),
        "documents",
      );
      if (page.results.length > 0) yield page.results as unknown as T[];
      offset += page.results.length;
      if (page.results.length < limit || offset >= page.total) return;
    }
  }

  async ensureReady(): Promise<{ created: boolean; settingsUpdated: boolean }> {
    let created = false;
    try {
      await this.write("GET", this.indexPath);
    } catch (error) {
      if (!(error instanceof SearchUnavailableError) || !error.message.includes("index_not_found")) throw error;
      await this.writeTask("POST", "/indexes", { uid: this.index, primaryKey: "id" });
      created = true;
    }
    const live = await this.write("GET", `${this.indexPath}/settings`);
    const changed = settingsDiff(live);
    if (changed.length === 0) return { created, settingsUpdated: false };
    const patch: Partial<IndexSettings> = Object.fromEntries(changed.map((key) => [key, SEARCH_SETTINGS[key]]));
    // Changing searchable/filterable attributes re-indexes every document: allow minutes.
    await this.writeTask("PATCH", `${this.indexPath}/settings`, patch, Math.max(this.options.taskTimeoutMs ?? 0, 600_000));
    return { created, settingsUpdated: true };
  }

  async healthy(): Promise<boolean> {
    try {
      await this.request("GET", "/health", { timeoutMs: 1000 });
      await this.request("POST", `${this.indexPath}/documents/fetch`, { key: this.key("read"), body: { fields: ["id"], limit: 1 }, timeoutMs: 1000 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Maintenance (worker, scripts; indexing key)

  async stats(): Promise<{ numberOfDocuments: number; isIndexing: boolean }> {
    const { numberOfDocuments, isIndexing } = this.parse(stats, await this.write("GET", `${this.indexPath}/stats`), "stats");
    return { numberOfDocuments, isIndexing };
  }

  /** True when the index exists (indexing key). */
  async exists(): Promise<boolean> {
    try {
      await this.write("GET", this.indexPath);
      return true;
    } catch (error) {
      if (error instanceof SearchUnavailableError && error.message.includes("index_not_found")) return false;
      throw error;
    }
  }

  /** Deletes this index (rebuild clean-up). */
  async deleteIndex(): Promise<void> {
    await this.writeTask("DELETE", this.indexPath);
  }

  /**
   * Atomically swaps this index with `other` (both must exist). A key scoped to listings_* cannot
   * read the swap task (its indexUid is null: 404), so completion is awaited through a no-op task
   * enqueued after it on this index: tasks run in enqueue order and swaps first.
   */
  async swapWith(other: string): Promise<void> {
    const { taskUid } = this.parse(taskRef, await this.write("POST", "/swap-indexes", [{ indexes: [this.index, other] }]), "swap");
    try {
      await this.waitForTask(taskUid);
    } catch (error) {
      if (!(error instanceof MeiliError) || error.code !== "task_not_found") throw error;
      await this.writeTask("POST", `${this.indexPath}/documents/delete-batch`, []);
    }
  }
}
