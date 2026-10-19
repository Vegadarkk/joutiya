import { describe, expect, it } from "vitest";
import { buildCsp, createNonce } from "@/lib/security/csp";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name as string, values]),
  );
}

describe("buildCsp", () => {
  it("requires a nonce for private pages", () => {
    expect(() => buildCsp({ variant: "private" })).toThrow(/nonce/);
  });

  it("uses nonce + strict-dynamic on private pages, with WebAssembly allowed (HEIC converter)", () => {
    const policy = directives(buildCsp({ variant: "private", nonce: "abc" }));
    expect(policy.get("script-src")).toEqual(["'nonce-abc'", "'strict-dynamic'", "'wasm-unsafe-eval'", "https:", "'unsafe-inline'"]);
  });

  it("adds pinned script hashes next to the nonce on private pages", () => {
    const policy = directives(buildCsp({ variant: "private", nonce: "abc", scriptHashes: ["h1=", "h2="] }));
    expect(policy.get("script-src")?.slice(0, 4)).toEqual(["'nonce-abc'", "'sha256-h1='", "'sha256-h2='", "'strict-dynamic'"]);
  });

  it("uses the 'self' fallback on public pages, without nonce nor WebAssembly", () => {
    const text = buildCsp({ variant: "public" });
    expect(directives(text).get("script-src")).toEqual(["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com", "https://accounts.google.com/gsi/client"]);
    expect(text).not.toContain("nonce");
    expect(text).not.toContain("wasm-unsafe-eval");
  });

  it("lets both variants fetch and draw the map tiles from the PMTiles origin", () => {
    for (const variant of ["public", "private"] as const) {
      const policy = directives(buildCsp({ variant, nonce: "abc", tilesOrigin: "https://media.joutiya.ma/maps/morocco.pmtiles" }));
      expect(policy.get("connect-src")).toContain("https://media.joutiya.ma");
      expect(policy.get("img-src")).toContain("https://media.joutiya.ma");
    }
    // Same host as the media origin: listed once.
    const shared = directives(buildCsp({ variant: "public", mediaOrigin: "https://media.joutiya.ma", tilesOrigin: "https://media.joutiya.ma/maps/x.pmtiles" }));
    expect(shared.get("img-src")?.filter((source) => source === "https://media.joutiya.ma")).toHaveLength(1);
    // Without a tiles URL nothing is added; an http host is dropped like any other.
    expect(buildCsp({ variant: "public" })).not.toContain("media.joutiya.ma");
    expect(buildCsp({ variant: "public", tilesOrigin: "http://tiles.example/x" })).not.toContain("tiles.example");
    expect(directives(buildCsp({ variant: "public", tilesOrigin: "http://localhost:3000/api/dev/storage/m/maps/x.pmtiles" })).get("connect-src")).toContain("http://localhost:3000");
  });

  it("locks framing, plugins, base and form targets", () => {
    const policy = directives(buildCsp({ variant: "public" }));
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
  });

  it("upgrades insecure requests outside dev unless told otherwise", () => {
    expect(buildCsp({ variant: "public" })).toContain("upgrade-insecure-requests");
    expect(buildCsp({ variant: "public", dev: true })).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ variant: "public", upgradeInsecure: false })).not.toContain("upgrade-insecure-requests");
  });

  it("adds dev-only sources in dev", () => {
    const policy = directives(buildCsp({ variant: "public", dev: true }));
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).toContain("ws:");
  });

  it("keeps only https origins (or localhost) for configured hosts", () => {
    const policy = directives(
      buildCsp({
        variant: "public",
        mediaOrigin: "https://media.joutiya.ma/path",
        r2Origin: "http://evil.example",
        errorIngestOrigin: "not a url",
      }),
    );
    expect(policy.get("img-src")).toContain("https://media.joutiya.ma");
    expect(policy.get("connect-src")?.join(" ")).not.toContain("evil.example");
  });

  it("declares the report endpoint when given", () => {
    const text = buildCsp({ variant: "public", reportPath: "/api/csp-report" });
    expect(text).toContain("report-uri /api/csp-report");
    expect(text).toContain("report-to csp");
  });
});

describe("createNonce", () => {
  it("returns 16 random bytes in base64", () => {
    const nonce = createNonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    expect(createNonce()).not.toBe(nonce);
  });
});
