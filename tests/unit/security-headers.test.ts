import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { SAME_ORIGIN_RESOURCE_SOURCE, staticSecurityHeaders } from "@/lib/security/headers";

// Static headers of next.config.ts (architecture §6). A next.config header wins over the one a route
// returns, so the development storage route, whose media bucket the admin host embeds like
// media.joutiya.ma, is left out of the global same-origin CORP and sets its own.

/** The headers next.config.ts gives `path`, matched as Next matches custom header sources. */
async function headersFor(path: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(path)) continue;
    for (const header of rule.headers) out[header.key.toLowerCase()] = header.value;
  }
  return out;
}

describe("static security headers", () => {
  it("keep CORP out of the list applied to every path", () => {
    expect(staticSecurityHeaders().map((header) => header.key)).not.toContain("Cross-Origin-Resource-Policy");
  });

  it("send a same-origin CORP everywhere but the development storage route", async () => {
    for (const path of ["/fr", "/fr/annonce/velo-abcd2345", "/api/health", "/api/dev/mailbox", "/api/dev/storage", "/_next/static/chunks/app.js", "/moderation/abcd2345"]) {
      const headers = await headersFor(path);
      expect(headers["cross-origin-resource-policy"], path).toBe("same-origin");
      expect(headers["x-content-type-options"], path).toBe("nosniff");
    }
    const media = await headersFor("/api/dev/storage/joutiya-dev-media/listings/abcd2345/photo0001-s.webp");
    expect(media["cross-origin-resource-policy"]).toBeUndefined();
    expect(media["x-content-type-options"]).toBe("nosniff");
    expect(media["content-security-policy"]).toContain("default-src 'none'");
  });

  it("match the exclusion on the path prefix only", () => {
    const match = getPathMatch(SAME_ORIGIN_RESOURCE_SOURCE, { strict: true, removeUnnamedParams: true });
    expect(match("/api/dev/storage/joutiya-dev-quarantine/uploads/x")).toBe(false);
    expect(match("/fr/api/dev/storage/x")).not.toBe(false);
    expect(match("/api/dev/storagex/y")).not.toBe(false);
  });
});
