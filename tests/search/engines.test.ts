import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MeiliEngine } from "@/lib/search/meili";
import { MemoryEngine } from "@/lib/search/memory";
import { SEARCH_SETTINGS, settingsDiff } from "@/lib/search/settings";
import { engineContract } from "./contract";
import { DOCS } from "./fixtures";

// `npm run test:search`: the engine contract on the memory engine and, when MEILI_URL,
// MEILI_SEARCH_KEY and MEILI_INDEX_KEY are set (CI service container, local docker run), on a real
// Meilisearch, in a throwaway index `listings_test_<random>` deleted afterwards.

engineContract("memory", async () => ({ engine: new MemoryEngine() }));

const { MEILI_URL: url, MEILI_SEARCH_KEY: searchKey, MEILI_INDEX_KEY: indexKey } = process.env;
const meiliConfigured = Boolean(url && searchKey && indexKey);

if (meiliConfigured && url) {
  const index = `listings_test_${randomBytes(4).toString("hex")}`;
  const engine = new MeiliEngine({ url, searchKey, indexKey, index });

  engineContract("meilisearch", async () => ({
    engine,
    cleanup: async () => {
      if (await engine.exists()) await engine.deleteIndex();
    },
  }));

  describe("meilisearch index setup", () => {
    it("applies the settings once, then finds nothing to change", async () => {
      const second = engine.withIndex(`${index}_setup`);
      try {
        expect(await second.ensureReady()).toEqual({ created: true, settingsUpdated: true });
        expect(await second.ensureReady()).toEqual({ created: false, settingsUpdated: false });
        const live: unknown = await (await fetch(`${url}/indexes/${second.index}/settings`, { headers: { authorization: `Bearer ${indexKey}` } })).json();
        expect(settingsDiff(live, SEARCH_SETTINGS)).toEqual([]);
        expect(await second.stats()).toMatchObject({ numberOfDocuments: 0 });
      } finally {
        if (await second.exists()) await second.deleteIndex();
      }
    }, 120_000);

    it("swaps two indexes with the scoped indexing key", async () => {
      const live = engine.withIndex(`${index}_live`);
      const next = engine.withIndex(`${index}_next`);
      try {
        await live.upsert(DOCS.slice(0, 1));
        await next.upsert(DOCS.slice(1, 3));
        await live.swapWith(next.index);
        expect(await live.stats()).toMatchObject({ numberOfDocuments: 2 });
        expect(await next.stats()).toMatchObject({ numberOfDocuments: 1 });
      } finally {
        for (const item of [live, next]) if (await item.exists()) await item.deleteIndex();
      }
    }, 120_000);
  });
} else {
  describe.skip("meilisearch engine contract (set MEILI_URL, MEILI_SEARCH_KEY, MEILI_INDEX_KEY)", () => {
    it("skipped", () => undefined);
  });
}
