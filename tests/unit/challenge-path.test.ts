import { describe, expect, it } from "vitest";
import { challengeNext, challengeUrlPath } from "@/lib/security/challenge-path";

// `next` of the /anti-robot page (design D14): same-site page paths only.

describe("challenge next path", () => {
  it("round-trips the page the proxy interrupted", () => {
    const path = "/ar/annonce/velo-casablanca-abcd2345?ref=a&b=c d";
    const url = new URL(challengeUrlPath("ar", path), "https://joutiya.ma");
    expect(url.pathname).toBe("/ar/anti-robot");
    expect(challengeNext(url.searchParams.get("next"), "ar")).toBe(path);
  });

  it("keeps locale-prefixed page paths", () => {
    for (const path of ["/fr", "/fr/c/vehicules", "/rif/profil/abcdefghjk", "/fr?x=1"]) expect(challengeNext(path, "fr")).toBe(path);
  });

  it("falls back to the locale home for anything else", () => {
    const refused = [
      undefined,
      null,
      "",
      "https://evil.example/fr",
      "//evil.example/fr",
      "/\\evil.example",
      "fr/annonce/x",
      "/api/search",
      "/en/annonce/x",
      "/fr/anti-robot?next=/fr",
      "/fr/annonce/x\n",
      `/fr/${"a".repeat(1100)}`,
    ];
    for (const value of refused) expect(challengeNext(value, "ar"), String(value)).toBe("/ar");
  });
});
