import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { INLINE_HASH_MARKER } from "@/lib/security/csp";
import * as proxyLimits from "@/lib/rate-limit/proxy-limits";

// Page-view limits (D14): the decision itself is unit-tested in proxy-limits.test.ts; here the
// spy only steers what the proxy does with it (the real check runs on the in-memory limiter).
vi.mock("@/lib/rate-limit/proxy-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof proxyLimits>();
  return { ...actual, checkPageLimits: vi.fn(actual.checkPageLimits) };
});
const checkPageLimits = vi.mocked(proxyLimits.checkPageLimits);

const request = (path: string, host = "joutiya.ma") => new NextRequest(`https://${host}${path}`, { headers: { host } });

beforeEach(() => {
  vi.stubEnv("ADMIN_HOST", "admin.joutiya.ma");
  vi.stubEnv("APP_ENV", "prod");
  vi.stubEnv("SITE_URL", "https://joutiya.ma");
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy", () => {
  it("hides the back office on the public host", async () => {
    for (const path of ["/admin", "/admin/x", "/api/admin/users"]) expect((await proxy(request(path))).status).toBe(404);
  });

  it("rewrites the admin host to /admin with a nonce CSP and noindex", async () => {
    const response = await proxy(request("/moderation", "admin.joutiya.ma"));
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://admin.joutiya.ma/admin/moderation");
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("serves only its own APIs on the admin host", async () => {
    expect((await proxy(request("/api/health", "admin.joutiya.ma"))).status).toBe(200);
    expect((await proxy(request("/api/health", "admin.joutiya.ma:443"))).status).toBe(200);
    expect((await proxy(request("/api/listings", "ADMIN.joutiya.ma."))).status).toBe(404);
    expect((await proxy(request("/api/listings", "admin.joutiya.ma"))).status).toBe(404);
  });

  it("redirects paths without a locale", async () => {
    const response = await proxy(request("/legal/cgu"));
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.headers.get("location")).toContain("/fr/legal/cgu");
  });

  it("marks public pages for inline-script hashing", async () => {
    const response = await proxy(request("/fr/legal/cgu"));
    expect(response.headers.get(INLINE_HASH_MARKER)).toBe("1");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("gives private pages a fresh nonce", async () => {
    const first = await proxy(request("/ar/connexion"));
    const second = await proxy(request("/ar/connexion"));
    expect(first.headers.get(INLINE_HASH_MARKER)).toBeNull();
    expect(first.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(first.headers.get("x-middleware-request-x-nonce")).not.toBe(second.headers.get("x-middleware-request-x-nonce"));
  });

  it("allows WebAssembly in the wizard (private) only", async () => {
    expect((await proxy(request("/fr/deposer"))).headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    expect((await proxy(request("/fr/annonce/velo-casablanca-abcd2345"))).headers.get("content-security-policy")).not.toContain("'wasm-unsafe-eval'");
  });

  it("adds the PMTiles origin to connect-src and img-src when a map is configured", async () => {
    const before = (await proxy(request("/fr/annonce/velo-casablanca-abcd2345"))).headers.get("content-security-policy") ?? "";
    expect(before).not.toContain("tiles.joutiya.ma");
    vi.stubEnv("MAP_PMTILES_URL", "https://tiles.joutiya.ma/maps/morocco.pmtiles");
    for (const path of ["/fr/annonce/velo-casablanca-abcd2345", "/fr/deposer"]) {
      const policy = (await proxy(request(path))).headers.get("content-security-policy") ?? "";
      const directive = (name: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
      expect(directive("connect-src")).toContain("https://tiles.joutiya.ma");
      expect(directive("img-src")).toContain("https://tiles.joutiya.ma");
    }
  });

  it("gives private pages a device cookie when the request has none, and public pages never", async () => {
    const fresh = await proxy(request("/fr/connexion"));
    const cookie = fresh.cookies.get("__Host-did");
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    // A valid cookie is kept; a forged one is replaced.
    const kept = await proxy(new NextRequest("https://joutiya.ma/fr/connexion", { headers: { host: "joutiya.ma", cookie: `__Host-did=${cookie!.value}` } }));
    expect(kept.cookies.get("__Host-did")).toBeUndefined();
    const forged = await proxy(new NextRequest("https://joutiya.ma/fr/connexion", { headers: { host: "joutiya.ma", cookie: "__Host-did=aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb" } }));
    expect(forged.cookies.get("__Host-did")?.value).not.toBe("aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb");
    expect((await proxy(request("/fr"))).headers.get("set-cookie")).toBeNull();
  });

  it("keeps staging out of search engines", async () => {
    vi.stubEnv("APP_ENV", "staging");
    expect((await proxy(request("/fr"))).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("can switch the CSP to report-only", async () => {
    vi.stubEnv("CSP_REPORT_ONLY", "true");
    const response = await proxy(request("/fr"));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
  });

  it("sends category pages with a query string to the clean path (308)", async () => {
    const response = await proxy(request("/fr/c/vehicules/casablanca?x=123&utm_source=a"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://joutiya.ma/fr/c/vehicules/casablanca");
    expect(checkPageLimits).not.toHaveBeenCalled();
    expect((await proxy(request("/fr/c/vehicules/casablanca"))).status).toBe(200);
    // Other pages keep their query.
    expect((await proxy(request("/fr/annonce/velo-casablanca-abcd2345?ref=1"))).status).toBe(200);
  });

  it("meters /annonce, /c, /profil and /boutique only", async () => {
    for (const path of ["/fr/annonce/velo-casablanca-abcd2345", "/ar/c/vehicules", "/rif/profil/abcdefghjk", "/fr/boutique/abcdefghjk"]) {
      checkPageLimits.mockClear();
      await proxy(request(path));
      expect(checkPageLimits, path).toHaveBeenCalledTimes(1);
    }
    for (const path of ["/fr", "/fr/recherche", "/fr/legal/cgu", "/fr/connexion", "/fr/anti-robot", "/api/listings"]) {
      checkPageLimits.mockClear();
      await proxy(request(path));
      expect(checkPageLimits, path).not.toHaveBeenCalled();
    }
  });

  it("sends a visitor over the limits without a pass to the challenge page, uncached", async () => {
    checkPageLimits.mockResolvedValueOnce({ kind: "challenge", retryAfterSeconds: 120 });
    const response = await proxy(request("/ar/annonce/velo-casablanca-abcd2345?ref=1"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/ar/anti-robot");
    expect(location.searchParams.get("next")).toBe("/ar/annonce/velo-casablanca-abcd2345?ref=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 429 with Retry-After once the pass allowance is spent, and to non-GET requests", async () => {
    checkPageLimits.mockResolvedValueOnce({ kind: "limited", retryAfterSeconds: 300 });
    const limited = await proxy(request("/fr/profil/abcdefghjk"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("300");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("content-type")).toContain("text/html");
    expect(limited.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await limited.text()).toContain('lang="fr"');
    checkPageLimits.mockResolvedValueOnce({ kind: "challenge", retryAfterSeconds: 60 });
    const post = await proxy(new NextRequest("https://joutiya.ma/fr/annonce/velo-casablanca-abcd2345", { method: "POST", headers: { host: "joutiya.ma" } }));
    expect(post.status).toBe(429);
    expect(post.headers.get("retry-after")).toBe("60");
  });

  it("lets verified bots through without counting them", async () => {
    const bot = new NextRequest("https://joutiya.ma/fr/annonce/velo-casablanca-abcd2345", { headers: { host: "joutiya.ma", "x-verified-bot": "1" } });
    const response = await proxy(bot);
    expect(response.status).toBe(200);
    expect(await checkPageLimits.mock.results.at(-1)?.value).toEqual({ kind: "allow" });
  });

  it("gives the search page a device cookie (dynamic page), keeping a valid one", async () => {
    const fresh = await proxy(request("/fr/recherche?q=velo"));
    const cookie = fresh.cookies.get("__Host-did");
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(fresh.headers.get(INLINE_HASH_MARKER)).toBe("1");
    const kept = await proxy(new NextRequest("https://joutiya.ma/fr/recherche", { headers: { host: "joutiya.ma", cookie: `__Host-did=${cookie!.value}` } }));
    expect(kept.cookies.get("__Host-did")).toBeUndefined();
    expect((await proxy(request("/fr/c/vehicules"))).headers.get("set-cookie")).toBeNull();
  });
});
