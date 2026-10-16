import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against the production build, served as in the Docker `web` target
// (standalone server + CSP hash hook): `npm run build && npm run test:e2e`.
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;
// Local runs may point at an existing Chromium instead of `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: "node scripts/start-standalone.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      APP_ENV: "dev",
      SITE_URL: baseURL,
      // Chromium resolves *.localhost to the loopback address.
      ADMIN_HOST: "admin.localhost",
      // Firebase emulators (npm run test:e2e runs inside `firebase emulators:exec`): demo project.
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya",
      FIREBASE_API_KEY: process.env.FIREBASE_API_KEY ?? "fake-api-key",
      FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
      // Sent mails stay in memory and are read back by the tests at /api/dev/mailbox.
      DEV_MAILBOX: "true",
      // Turnstile test keys: always pass (Cloudflare's documented dummy pair).
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      // WhatsApp verification: dummy credentials, the tests sign the webhook payloads themselves
      // (tests/e2e/phone.spec.ts keeps the same values); the display number is the dev placeholder.
      WHATSAPP_APP_SECRET: "e2e-whatsapp-app-secret",
      WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
      WHATSAPP_VERIFY_TOKEN: "e2e-whatsapp-verify-token",
      WHATSAPP_DISPLAY_NUMBER: "212600000000",
      METADATA_SERVER_DETECTION: "none",
    },
  },
});
