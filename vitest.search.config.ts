import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

// Engine contract suite (design D1): `npm run test:search`. The memory engine always; a real
// Meilisearch when MEILI_URL, MEILI_SEARCH_KEY and MEILI_INDEX_KEY are set (CI service container).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      { find: /^server-only$/, replacement: `${src}/lib/empty.ts` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/search/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
