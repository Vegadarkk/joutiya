import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      // Next.js enforces "server-only" at build time; unit tests import server modules directly.
      { find: /^server-only$/, replacement: `${src}/lib/empty.ts` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
    // The CSP hook test patches http.ServerResponse: one process per file.
    pool: "forks",
    restoreMocks: true,
    // next-intl imports "next/server" without an extension: let Vite resolve it.
    server: { deps: { inline: [/next-intl/] } },
  },
});
