import "server-only";
import { serverEnv, type ServerEnv } from "@/lib/env";
import { MeiliEngine } from "./meili";
import { MemoryEngine } from "./memory";
import { SearchUnavailableError, type SearchEngine } from "./types";

// Engine factory (design D1, D2): Meilisearch when MEILI_URL is set; in development without it, one
// in-memory engine per process (kept on globalThis so route handlers, server components and the dev
// rebuild route share it across Next bundles and reloads); elsewhere SearchUnavailableError, which
// callers turn into 503 `search_unavailable` or an error state.

const DEV_MEMORY = Symbol.for("joutiya.search.devMemoryEngine");
type GlobalWithEngine = typeof globalThis & { [DEV_MEMORY]?: MemoryEngine };

/** The development memory engine of this process (created on first use). */
export function devMemoryEngine(): MemoryEngine {
  const store = globalThis as GlobalWithEngine;
  store[DEV_MEMORY] ??= new MemoryEngine();
  return store[DEV_MEMORY];
}

/** True when a Meilisearch server is configured (health report). */
export function isMeiliConfigured(env: ServerEnv = serverEnv()): boolean {
  return Boolean(env.MEILI_URL);
}

/** Engine for `env`, built on every call; searchEngine() caches one. */
export function createSearchEngine(env: ServerEnv): SearchEngine {
  if (env.MEILI_URL) return new MeiliEngine({ url: env.MEILI_URL, searchKey: env.MEILI_SEARCH_KEY, indexKey: env.MEILI_INDEX_KEY });
  if (env.APP_ENV === "dev") return devMemoryEngine();
  throw new SearchUnavailableError("search is not configured: set MEILI_URL");
}

let shared: SearchEngine | undefined;
let override: SearchEngine | null = null;

/** The process-wide engine; throws SearchUnavailableError outside dev without MEILI_URL. */
export function searchEngine(): SearchEngine {
  if (override) return override;
  shared ??= createSearchEngine(serverEnv());
  return shared;
}

/** Tests only: serve `engine` from searchEngine() until reset (null restores the configured one). */
export function setSearchEngineForTests(engine: SearchEngine | null): void {
  override = engine;
}

/** Tests only: forget the cached engine and any test engine (the dev memory engine keeps its data). */
export function resetSearchEngine(): void {
  shared = undefined;
  override = null;
}
