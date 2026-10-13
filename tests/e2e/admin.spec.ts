import { expect, test } from "@playwright/test";

// ADMIN_HOST=admin.localhost (playwright.config.ts). Outside dev the layout also requires a valid
// Cloudflare Access token; dev without CF_ACCESS_AUD skips it.
const admin = "http://admin.localhost:3100";

test("the admin host serves the back office under a nonce CSP", async ({ page }) => {
  const response = await page.goto(`${admin}/`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /quotas gratuits/i })).toBeVisible();
  const csp = response!.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/'nonce-[^']+'/);
  expect(response!.headers()["x-robots-tag"] ?? "").toMatch(/noindex/);
});

test("the admin host exposes no public API", async ({ request }) => {
  // Node does not resolve *.localhost: same server, admin Host header.
  const headers = { host: "admin.localhost:3100" };
  expect((await request.get("/api/search", { headers })).status()).toBe(404);
  expect((await request.get("/api/health", { headers })).status()).toBe(200);
});
