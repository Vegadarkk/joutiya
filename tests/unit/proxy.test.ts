import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { INLINE_HASH_MARKER } from "@/lib/security/csp";

const request = (path: string, host = "joutiya.ma") => new NextRequest(`https://${host}${path}`, { headers: { host } });

beforeEach(() => {
  vi.stubEnv("ADMIN_HOST", "admin.joutiya.ma");
  vi.stubEnv("APP_ENV", "prod");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://joutiya.ma");
});
afterEach(() => vi.unstubAllEnvs());

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
