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

  it("uses nonce + strict-dynamic on private pages", () => {
    const policy = directives(buildCsp({ variant: "private", nonce: "abc" }));
    expect(policy.get("script-src")).toEqual(["'nonce-abc'", "'strict-dynamic'", "https:", "'unsafe-inline'"]);
  });

  it("uses the 'self' fallback on public pages, without nonce", () => {
    const text = buildCsp({ variant: "public" });
    expect(directives(text).get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(text).not.toContain("nonce");
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
