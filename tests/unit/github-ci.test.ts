import { describe, expect, it } from "vitest";
import { readEdgeFile, type AccessApp } from "../../scripts/cloudflare";
import { AGE_RECIPIENT, BUNDLE_FORMAT, bypassSecret, parseBundle, SCAN_HEADER, SECRET_NAMES, VARIABLE_NAMES } from "../../scripts/github-ci";

const REPOSITORY = "Vegadarkk/joutiya";
const RECIPIENT = `age1${"q".repeat(58)}`;
const bundle = (secrets: Record<string, string>, variables: Record<string, string>): string =>
  JSON.stringify({ format: BUNDLE_FORMAT, repository: REPOSITORY, keyId: "123", secrets, variables });

describe("github-ci bundles", () => {
  it("takes the scan and load-test names", () => {
    const parsed = parseBundle(
      bundle(
        { STAGING_SCAN_ACCESS_TOKEN: "c2VhbGVk", LOADTEST_BYPASS_SECRET: "c2VhbGVk" },
        { ACCESS_TOKEN_HEADER: SCAN_HEADER, SCAN_REPORT_AGE_RECIPIENT: RECIPIENT, SECURITY_SCAN_ENABLED: "true", LOAD_TEST_ENABLED: "true" },
      ),
      REPOSITORY,
    );
    expect(Object.keys(parsed.secrets)).toEqual(["STAGING_SCAN_ACCESS_TOKEN", "LOADTEST_BYPASS_SECRET"]);
    expect(SECRET_NAMES).toContain("LOADTEST_BYPASS_SECRET");
    expect(VARIABLE_NAMES).toContain("SCAN_REPORT_AGE_RECIPIENT");
  });

  it("refuses unknown names, a switch other than true, another header and a bad age key", () => {
    expect(() => parseBundle(bundle({ OTHER: "c2VhbGVk" }, {}), REPOSITORY)).toThrow(/OTHER/);
    expect(() => parseBundle(bundle({}, { LOAD_TEST_ENABLED: "false" }), REPOSITORY)).toThrow(/LOAD_TEST_ENABLED can only be true/);
    expect(() => parseBundle(bundle({}, { ACCESS_TOKEN_HEADER: "authorization" }), REPOSITORY)).toThrow(/ACCESS_TOKEN_HEADER/);
    expect(() => parseBundle(bundle({}, { SCAN_REPORT_AGE_RECIPIENT: "age1short" }), REPOSITORY)).toThrow(/age public key/);
    expect(AGE_RECIPIENT.test(RECIPIENT)).toBe(true);
  });

  it("draws bypass secrets as LOADTEST_BYPASS_SECRET takes them", () => {
    const secret = bypassSecret();
    expect(secret).toMatch(/^[A-Za-z0-9]{64}$/);
    expect(bypassSecret()).not.toBe(secret);
  });

  it("names the same single header as staging's Access application", () => {
    const staging = readEdgeFile<{ apps: AccessApp[] }>("access-apps.json").apps.find((app) => app.domain === "staging.joutiya.ma");
    expect(staging?.read_service_tokens_from_header).toBe(SCAN_HEADER);
  });
});
