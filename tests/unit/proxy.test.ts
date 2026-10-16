import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { resetServerEnv } from "@/lib/env";
import { INLINE_HASH_MARKER } from "@/lib/security/csp";

const request = (path: string, host = "joutiya.ma") => new NextRequest(`https://${host}${path}`, { headers: { host } });

beforeEach(() => {
  vi.stubEnv("ADMIN_HOST", "admin.joutiya.ma");
  vi.stubEnv("APP_ENV", "prod");
  vi.stubEnv("SITE_URL", "https://joutiya.ma");
  // The media origin comes from the parsed (cached) environment.
  resetServerEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnv();
});

/** One directive of a policy, e.g. "img-src 'self' data: ...". */
const directive = (policy: string, name: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";

describe("proxy", () => {
  it("hides the back office on the public host", () => {
    for (const path of ["/admin", "/admin/x", "/api/admin/users"]) expect(proxy(request(path)).status).toBe(404);
  });

  it("rewrites the admin host to /admin with a nonce CSP and noindex", () => {
    const response = proxy(request("/moderation", "admin.joutiya.ma"));
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://admin.joutiya.ma/admin/moderation");
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("serves only its own APIs on the admin host", () => {
    expect(proxy(request("/api/health", "admin.joutiya.ma")).status).toBe(200);
    expect(proxy(request("/api/health", "admin.joutiya.ma:443")).status).toBe(200);
    expect(proxy(request("/api/listings", "ADMIN.joutiya.ma.")).status).toBe(404);
    expect(proxy(request("/api/listings", "admin.joutiya.ma")).status).toBe(404);
  });

  it("redirects paths without a locale", () => {
    const response = proxy(request("/legal/cgu"));
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.headers.get("location")).toContain("/fr/legal/cgu");
  });

  it("marks public pages for inline-script hashing", () => {
    const response = proxy(request("/fr/legal/cgu"));
    expect(response.headers.get(INLINE_HASH_MARKER)).toBe("1");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("gives private pages a fresh nonce", () => {
    const first = proxy(request("/ar/connexion"));
    const second = proxy(request("/ar/connexion"));
    expect(first.headers.get(INLINE_HASH_MARKER)).toBeNull();
    expect(first.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(first.headers.get("x-middleware-request-x-nonce")).not.toBe(second.headers.get("x-middleware-request-x-nonce"));
  });

  it("allows WebAssembly in the wizard (private) only", () => {
    expect(proxy(request("/fr/deposer")).headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    expect(proxy(request("/fr/annonce/velo-casablanca-abcd2345")).headers.get("content-security-policy")).not.toContain("'wasm-unsafe-eval'");
  });

  it("adds the PMTiles origin to connect-src and img-src when a map is configured", () => {
    const before = proxy(request("/fr/annonce/velo-casablanca-abcd2345")).headers.get("content-security-policy") ?? "";
    expect(before).not.toContain("tiles.joutiya.ma");
    vi.stubEnv("MAP_PMTILES_URL", "https://tiles.joutiya.ma/maps/morocco.pmtiles");
    for (const path of ["/fr/annonce/velo-casablanca-abcd2345", "/fr/deposer"]) {
      const policy = proxy(request(path)).headers.get("content-security-policy") ?? "";
      const directive = (name: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
      expect(directive("connect-src")).toContain("https://tiles.joutiya.ma");
      expect(directive("img-src")).toContain("https://tiles.joutiya.ma");
    }
  });

  it("gives private pages a device cookie when the request has none, and public pages never", () => {
    const fresh = proxy(request("/fr/connexion"));
    const cookie = fresh.cookies.get("__Host-did");
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    // A valid cookie is kept; a forged one is replaced.
    const kept = proxy(new NextRequest("https://joutiya.ma/fr/connexion", { headers: { host: "joutiya.ma", cookie: `__Host-did=${cookie!.value}` } }));
    expect(kept.cookies.get("__Host-did")).toBeUndefined();
    const forged = proxy(new NextRequest("https://joutiya.ma/fr/connexion", { headers: { host: "joutiya.ma", cookie: "__Host-did=aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb" } }));
    expect(forged.cookies.get("__Host-did")?.value).not.toBe("aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb");
    expect(proxy(request("/fr")).headers.get("set-cookie")).toBeNull();
  });

  it("lets the admin host show photos from the media host, and from the public origin's dev route in development", () => {
    vi.stubEnv("MEDIA_BASE_URL", "https://media.joutiya.ma/");
    resetServerEnv();
    const deployed = proxy(request("/moderation/abcd2345", "admin.joutiya.ma")).headers.get("content-security-policy") ?? "";
    expect(directive(deployed, "img-src")).toBe("img-src 'self' data: blob: https://media.joutiya.ma");

    // Development without MEDIA_BASE_URL: photos come from /api/dev/storage on SITE_URL, another
    // origin than admin.localhost. The staff route /photos/... is same-origin ('self').
    vi.stubEnv("MEDIA_BASE_URL", "");
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("ADMIN_HOST", "admin.localhost");
    resetServerEnv();
    const dev = proxy(request("/moderation/abcd2345", "admin.localhost:3100")).headers.get("content-security-policy") ?? "";
    expect(directive(dev, "img-src")).toContain("http://localhost:3100");
    expect(directive(dev, "img-src")).toContain("'self'");

    // Deployed without a media host: no extra origin.
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("SITE_URL", "https://staging.joutiya.ma");
    vi.stubEnv("ADMIN_HOST", "admin.staging.joutiya.ma");
    resetServerEnv();
    const bare = proxy(request("/moderation", "admin.staging.joutiya.ma")).headers.get("content-security-policy") ?? "";
    expect(directive(bare, "img-src")).toBe("img-src 'self' data: blob:");
  });

  it("keeps staging out of search engines", () => {
    vi.stubEnv("APP_ENV", "staging");
    expect(proxy(request("/fr")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("can switch the CSP to report-only", () => {
    vi.stubEnv("CSP_REPORT_ONLY", "true");
    const response = proxy(request("/fr"));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
  });
});
