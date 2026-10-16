import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

// API tests against the Firebase emulators (Auth + Firestore): role matrix, IDOR, CSRF, lockout.
// `npm run test:api` starts the emulators around this run.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      { find: /^server-only$/, replacement: `${src}/lib/empty.ts` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/api/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
    server: { deps: { inline: [/next-intl/] } },
    env: {
      APP_ENV: "dev",
      SITE_URL: "http://localhost:3000",
      ADMIN_HOST: "admin.localhost",
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya",
      FIREBASE_API_KEY: "fake-api-key",
      FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
      DEV_MAILBOX: "true",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      LOG_LEVEL: "silent",
      // google-auth-library would probe the GCE metadata server through the proxy (noise only).
      METADATA_SERVER_DETECTION: "none",
    },
  },
});
