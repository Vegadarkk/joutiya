import { afterEach, describe, expect, it } from "vitest";
import { createSearchEngine, devMemoryEngine, isMeiliConfigured, resetSearchEngine, searchEngine, setSearchEngineForTests } from "@/lib/search/engine";
import { parseEnv, resetServerEnv } from "@/lib/env";
import { MeiliEngine } from "@/lib/search/meili";
import { MemoryEngine } from "@/lib/search/memory";
import { SearchUnavailableError } from "@/lib/search/types";

const env = (vars: Record<string, string>) => parseEnv(vars).env;

describe("search engine factory", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetServerEnv();
    resetSearchEngine();
  });

  it("builds a Meilisearch engine when MEILI_URL is set", () => {
    const engine = createSearchEngine(env({ APP_ENV: "dev", MEILI_URL: "http://127.0.0.1:7700", MEILI_SEARCH_KEY: "s" }));
    expect(engine).toBeInstanceOf(MeiliEngine);
    expect(engine.kind).toBe("meili");
    expect((engine as MeiliEngine).index).toBe("listings_v1");
    expect(isMeiliConfigured(env({ MEILI_URL: "http://127.0.0.1:7700" }))).toBe(true);
    expect(isMeiliConfigured(env({}))).toBe(false);
  });

  it("serves one process-wide memory engine in development without MEILI_URL", () => {
    const first = createSearchEngine(env({ APP_ENV: "dev" }));
    expect(first).toBeInstanceOf(MemoryEngine);
    expect(createSearchEngine(env({ APP_ENV: "dev" }))).toBe(first);
    expect(devMemoryEngine()).toBe(first);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("joutiya.search.devMemoryEngine")]).toBe(first);
  });

  it("refuses to run without MEILI_URL outside development", () => {
    expect(() => createSearchEngine(env({ APP_ENV: "staging" }))).toThrow(SearchUnavailableError);
    expect(() => createSearchEngine(env({ APP_ENV: "prod" }))).toThrow(SearchUnavailableError);
  });

  it("caches the engine and lets tests replace it", () => {
    process.env = { ...saved, APP_ENV: "dev" };
    delete process.env.MEILI_URL;
    resetServerEnv();
    const configured = searchEngine();
    expect(searchEngine()).toBe(configured);
    const fake = new MemoryEngine();
    setSearchEngineForTests(fake);
    expect(searchEngine()).toBe(fake);
    setSearchEngineForTests(null);
    expect(searchEngine()).toBe(configured);
    setSearchEngineForTests(fake);
    resetSearchEngine();
    expect(searchEngine()).not.toBe(fake);
  });

  it("throws at use time in staging without MEILI_URL", () => {
    process.env = { ...saved, APP_ENV: "staging" };
    delete process.env.MEILI_URL;
    resetServerEnv();
    expect(() => searchEngine()).toThrow(SearchUnavailableError);
  });
});
