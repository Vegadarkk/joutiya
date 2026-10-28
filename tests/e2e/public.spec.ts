import { expect, test, type Page } from "@playwright/test";
import { apiContentSecurityPolicy, staticSecurityHeaders } from "../../src/lib/security/headers";

/** The headers next.config.ts applies to every path (src/lib/security/headers.ts), by lower-cased name. */
const STATIC_HEADERS = Object.fromEntries(staticSecurityHeaders().map((header) => [header.key.toLowerCase(), header.value]));

/** Every static security header of a served response, CORP included; nothing names the server. */
function expectStaticHeaders(headers: Record<string, string>, where: string): void {
  for (const [name, value] of Object.entries(STATIC_HEADERS)) expect(headers[name], `${name} on ${where}`).toBe(value);
  expect(headers["cross-origin-resource-policy"], where).toBe("same-origin");
  expect(headers["x-powered-by"], where).toBeUndefined();
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

const LOGO_FILE = { light: "/brand/joutiya-logo.svg", dark: "/brand/joutiya-logo-dark.svg" } as const;

/** The header and footer each show the logo file of the theme, loaded and decoded. */
async function expectLogos(page: Page, theme: keyof typeof LOGO_FILE): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  for (const area of [page.getByRole("banner"), page.getByRole("contentinfo")]) {
    const logo = area.locator('img[src^="/brand/joutiya-logo"]:visible');
    await expect(logo).toHaveCount(1);
    await expect(logo).toHaveAttribute("src", LOGO_FILE[theme]);
    // Lazy (src/components/layout/logo.tsx): the footer one loads near the viewport only.
    await logo.scrollIntoViewIfNeeded();
    // A missing or undecodable file leaves naturalWidth at 0 (the broken-image icon).
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
}

test.describe("public pages", () => {
  for (const [locale, lang, dir] of [
    ["fr", "fr-MA", "ltr"],
    ["ar", "ar-MA", "rtl"],
    ["rif", "rif-Latn", "ltr"],
  ] as const) {
    // French and Arabic (RTL) at phone width too; Tarifit waits for its review (audit C3-02).
    test(`/${locale} renders with lang and dir, under a hash CSP, without violations`, { tag: locale === "rif" ? [] : ["@mobile"] }, async ({ page }) => {
      const violations = await watchCsp(page);
      const response = await page.goto(`/${locale}`);
      expect(response?.status()).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);

      const headers = response!.headers();
      const csp = headers["content-security-policy"] ?? "";
      const scriptSrc = csp.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
      expect(scriptSrc).toContain("'sha256-");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'nonce-");
      expect(headers["set-cookie"]).toBeUndefined();
      expectStaticHeaders(headers, `/${locale}`);
      expect(headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
      expect(headers["reporting-endpoints"]).toBe('csp="/api/csp-report"');
      expect(csp).toContain("frame-ancestors 'none'");

      // The theme script ran before paint and hydration completed.
      await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
      await page.waitForLoadState("networkidle");
      expect(violations).toEqual([]);
    });
  }

  test("/ redirects to a locale", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/fr$/);
  });

  test("the locale switcher changes the locale and remembers it", async ({ page, context }) => {
    await page.goto("/fr");
    await page.getByRole("button", { name: /langue/i }).click();
    await page.getByRole("menuitem", { name: "العربية" }).click();
    await expect(page).toHaveURL(/\/ar$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const cookie = (await context.cookies()).find((item) => item.name === "NEXT_LOCALE");
    expect(cookie?.value).toBe("ar");
    await page.goto("/");
    await expect(page).toHaveURL(/\/ar$/);
  });

  test("footer links lead to the legal pages", async ({ page }) => {
    await page.goto("/fr");
    const footer = page.locator("footer");
    await footer.getByRole("link", { name: /mentions légales/i }).click();
    await expect(page).toHaveURL(/\/fr\/legal\/mentions-legales$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/mentions légales/i);
    await expect(page.getByText("6 rue d'Armaillé", { exact: false })).toBeVisible();
  });

  // Each theme has its own logo file; the other one is first fetched on the switch.
  for (const [first, second] of [["light", "dark"], ["dark", "light"]] as const) {
    test(`the ${first} logo shows, then the ${second} one after a theme switch`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem("theme", theme), first);
      await page.goto("/fr");
      await expectLogos(page, first);
      await page.getByRole("contentinfo").getByRole("radio", { name: second === "light" ? "Clair" : "Sombre" }).click();
      await expectLogos(page, second);
    });
  }

  // Own dark theme: Dark Reader-style extensions stay off (src/lib/i18n/metadata.ts).
  test("public and private pages carry the Dark Reader lock", async ({ request }) => {
    for (const path of ["/fr", "/fr/connexion"]) {
      expect(await (await request.get(path)).text()).toContain('<meta name="darkreader-lock"');
    }
  });

  test("unknown pages answer 404 in the visitor's locale", async ({ page }) => {
    const response = await page.goto("/fr/cette-page-n-existe-pas");
    expect(response?.status()).toBe(404);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr-MA");
  });

  test("the back office does not exist on the public host", async ({ request }) => {
    expect((await request.get("/admin")).status()).toBe(404);
    expect((await request.get("/api/admin/quotas")).status()).toBe(404);
  });
});

test.describe("security headers", () => {
  test("the API answers under its own CSP, uncached, without CORS, with the device cookie only", async ({ request }) => {
    const response = await request.get("/api/auth/me");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expectStaticHeaders(headers, "/api/auth/me");
    expect(headers["content-security-policy"]).toBe(apiContentSecurityPolicy);
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    // The first anonymous call sets the device cookie (§6 rate-limit keys) and no other cookie.
    const cookies = response.headersArray().filter((header) => header.name.toLowerCase() === "set-cookie");
    expect(cookies.map((header) => header.value.split("=")[0])).toEqual(["__Host-did"]);
    expect(cookies[0]?.value).toMatch(/; *HttpOnly/i);
  });

  test("the proxy's own 404 (back office on the public host) keeps the static headers", async ({ request }) => {
    const response = await request.get("/admin");
    expect(response.status()).toBe(404);
    expectStaticHeaders(response.headers(), "/admin");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });
});

test.describe("private pages", () => {
  test("use a per-request nonce, never cached", async ({ request }) => {
    const first = await request.get("/fr/connexion");
    const second = await request.get("/fr/connexion");
    expect(first.status()).toBe(200);
    const nonce = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
    const a = nonce(first.headers()["content-security-policy"] ?? "");
    const b = nonce(second.headers()["content-security-policy"] ?? "");
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect(first.headers()["cache-control"]).toMatch(/no-store/);
  });
});

test.describe("service endpoints", () => {
  test("health answers without caching", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("robots.txt blocks everything outside production", async ({ request }) => {
    const body = await (await request.get("/robots.txt")).text();
    expect(body).toMatch(/Disallow: \/\s*$/m);
  });
});
