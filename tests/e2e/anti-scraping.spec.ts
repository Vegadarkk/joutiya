import { randomInt } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Page-view limits of the server-rendered pages (phase 4, design D14) against the production build
// (npm run test:e2e). The proxy meters /annonce, /c, /profil and /boutique: a visitor 120 per hour
// per device (__Host-did, issued by the proxy on private pages), 1 200 per hour per IP; the e2e
// server has no RATE_LIMIT_REDIS_URL, so the in-memory limiter of the proxy bundle applies that
// table. Past the device budget a GET goes to /{locale}/anti-robot; a solved Turnstile (always-pass
// test keys, playwright.config.ts) sets a 30-minute pass bound to the device.
// Each test spends a device and an IP bucket of its own: the app takes the client address from
// CF-Connecting-IP (security/ip.ts), so the ~380 views sent here with a TEST-NET-3 address never
// touch the 1 200 per hour the other specs share on the loopback address (about 30 metered views).
// Only the two browser navigations of the last test count there.

const PAGE = "/fr/c/vehicules";
const CHALLENGE = "/fr/anti-robot";
/** pages.device (src/config/rate-limits.ts): page views per hour of a visitor's device. */
const DEVICE_BUDGET = 120;
/** Parallel requests per batch: quick, without flooding the single standalone process. */
const BATCH = 10;
/** The token of the always-pass test site key; the test secret accepts it. */
const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** A client address of its own (TEST-NET-3), sent as Cloudflare would. */
const testIp = () => `203.0.113.${randomInt(1, 255)}`;

/**
 * Headers of a visitor: its address and the verdict Cloudflare's transform rule writes on every
 * request (X-Verified-Bot overwritten to 0, or 1 for a verified crawler).
 */
function visitorHeaders(): Record<string, string> {
  return { "cf-connecting-ip": testIp(), "x-verified-bot": "0" };
}

/** A fresh device in this context's cookies: the proxy issues __Host-did on private pages. */
async function newDevice(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
  const response = await request.get(CHALLENGE, { headers, maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()["set-cookie"]).toContain("__Host-did=");
}

/** `count` views of PAGE, BATCH at a time, never following a redirect: the statuses that were not 200. */
async function views(request: APIRequestContext, count: number, headers: Record<string, string>): Promise<number[]> {
  const others: number[] = [];
  for (let sent = 0; sent < count; sent += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, count - sent) }, async () => {
      const response = await request.get(PAGE, { headers, maxRedirects: 0 });
      const status = response.status();
      await response.dispose();
      return status;
    });
    others.push(...(await Promise.all(batch)).filter((status) => status !== 200));
  }
  return others;
}

/** Collects CSP violations reported by the page itself. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__cspViolation", (detail: string) => violations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolation: (detail: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

test.describe("page-view limits", () => {
  test("the 121st page of a visitor goes to the challenge, and its pass lets the same page through", async ({ request, baseURL }) => {
    const visitor = visitorHeaders();
    await newDevice(request, visitor);
    expect(await views(request, DEVICE_BUDGET, visitor)).toEqual([]);

    const over = await request.get(PAGE, { headers: visitor, maxRedirects: 0 });
    expect(over.status()).toBe(302);
    // Never cached: Cloudflare would keep a bare 302 and send every visitor to the challenge.
    expect(over.headers()["cache-control"]).toContain("no-store");
    const target = new URL(over.headers()["location"] ?? "", baseURL);
    expect(target.pathname).toBe(CHALLENGE);
    expect(target.searchParams.get("next")).toBe(PAGE);

    // No session: the Origin check stands in for CSRF, so another origin gets no pass.
    const pass = (origin: string) => request.post("/api/challenge/pass", { headers: { ...visitor, origin }, data: { token: TEST_TOKEN } });
    const foreign = await pass("https://evil.example");
    expect(foreign.status()).toBe(403);
    expect(foreign.headers()["set-cookie"]).toBeUndefined();
    const solved = await pass(new URL(baseURL!).origin);
    expect(solved.status()).toBe(204);
    // Bound to the device cookie the visitor already has: no new one.
    expect(solved.headers()["set-cookie"]).toContain("__Host-tsv=");
    expect(solved.headers()["set-cookie"]).not.toContain("__Host-did=");

    const passed = await request.get(PAGE, { headers: visitor, maxRedirects: 0 });
    expect(passed.status()).toBe(200);
  });

  test("a verified bot is never metered", async ({ request }) => {
    const visitor = visitorHeaders();
    await newDevice(request, visitor);
    const bot = { ...visitor, "x-verified-bot": "1" };
    expect(await views(request, DEVICE_BUDGET + 10, bot)).toEqual([]);
    // None of them counted: the same device, as a visitor, is still within its budget.
    expect((await request.get(PAGE, { headers: visitor, maxRedirects: 0 })).status()).toBe(200);
  });

  test("a browser over the limit solves the challenge under its nonce CSP and comes back", async ({ page }) => {
    const violations = await watchCsp(page);
    // The browser's own device cookie, from a private page that stays put (the challenge page
    // would solve itself and leave). page.request shares it: the device spends its budget there.
    await page.goto("/fr/connexion");
    expect((await page.context().cookies()).some((cookie) => cookie.name === "__Host-did")).toBe(true);
    expect(await views(page.request, DEVICE_BUDGET, visitorHeaders())).toEqual([]);

    const passed = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/challenge/pass", { timeout: 20_000 });
    // "commit": the solved page may leave before its load event, which would interrupt goto.
    const response = await page.goto(PAGE, { waitUntil: "commit" });
    expect(response?.request().redirectedFrom()?.url()).toMatch(/\/fr\/c\/vehicules$/);
    const landed = new URL(response?.url() ?? "", "http://localhost");
    expect(landed.pathname).toBe(CHALLENGE);
    expect(landed.searchParams.get("next")).toBe(PAGE);
    expect(response?.status()).toBe(200);
    // Private page: a per-request nonce (the Turnstile script needs it), never cached.
    const csp = response?.headers()["content-security-policy"] ?? "";
    const scriptSrc = csp.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(response?.headers()["cache-control"]).toMatch(/no-store/);

    // The test site key solves the widget by itself: the page posts the token, then goes back.
    expect((await passed).status()).toBe(204);
    await expect(page).toHaveURL(/\/fr\/c\/vehicules$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Véhicules au Maroc" })).toBeVisible();
    expect(violations).toEqual([]);
  });
});
