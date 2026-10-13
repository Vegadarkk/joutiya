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
      NEXT_PUBLIC_SITE_URL: baseURL,
      // Chromium resolves *.localhost to the loopback address.
      ADMIN_HOST: "admin.localhost",
    },
  },
});
