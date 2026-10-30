import { describe, expect, it } from "vitest";
import { parseReportReference } from "@/lib/reports/reference";

// The contact page's "Signaler un contenu illicite" (DSA art. 16(1), Phase 6 review of 29 Oct 2026):
// an address or a bare reference names a listing or a profile; anything else is refused before the
// notice form opens.

describe("parseReportReference", () => {
  it("reads a listing from its address, its reference or its path segment", () => {
    expect(parseReportReference("https://aalan.ma/fr/annonce/velo-cargo-casablanca-abcd2345")).toEqual({ type: "listing", id: "abcd2345", label: "velo-cargo-casablanca-abcd2345" });
    expect(parseReportReference(" aalan.ma/ar/annonce/velo-abcd2345?from=mail#photos ")).toEqual({ type: "listing", id: "abcd2345", label: "velo-abcd2345" });
    expect(parseReportReference("http://localhost:3100/annonce/x-ABCD2345")).toEqual({ type: "listing", id: "abcd2345", label: "x-ABCD2345" });
    expect(parseReportReference("ABCD2345")).toEqual({ type: "listing", id: "abcd2345", label: "abcd2345" });
  });

  it("reads a profile from its address or its public id", () => {
    expect(parseReportReference("https://aalan.ma/fr/profil/abcdefghjk")).toEqual({ type: "user", id: "abcdefghjk", label: "abcdefghjk" });
    expect(parseReportReference("abcdefghjk")).toEqual({ type: "user", id: "abcdefghjk", label: "abcdefghjk" });
  });

  it("refuses what names nothing on the site", () => {
    const refused = [
      "",
      "   ",
      "abcd0345",
      "une annonce avec des espaces",
      "https://aalan.ma/fr/boutique/maison-lalla-abcdefgh",
      "https://aalan.ma/fr/annonce/",
      "https://aalan.ma/fr/profil/short",
      "https://aalan.ma/fr/recherche?q=velo",
      "mailto:dsa@example.test",
      "javascript:alert(1)",
      "ftp://aalan.ma/fr/annonce/velo-abcd2345",
    ];
    for (const input of refused) expect(parseReportReference(input), input).toBeNull();
  });
});
