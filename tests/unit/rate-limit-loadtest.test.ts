import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { isLoadTestRequest, LOADTEST_HEADER } from "@/lib/rate-limit/loadtest";

// Load test bypass (phase 6, D17): staging only, exact secret.

const SECRET = "a".repeat(20) + "B7".repeat(10);
const headers = (value?: string) => new Headers(value === undefined ? {} : { [LOADTEST_HEADER]: value });

describe("isLoadTestRequest", () => {
  it("lets the exact secret through in staging", () => {
    expect(isLoadTestRequest(headers(SECRET), { APP_ENV: "staging", LOADTEST_BYPASS_SECRET: SECRET })).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isLoadTestRequest(headers(SECRET), { APP_ENV: "prod", LOADTEST_BYPASS_SECRET: SECRET })).toBe(false);
    expect(isLoadTestRequest(headers(SECRET), { APP_ENV: "dev", LOADTEST_BYPASS_SECRET: SECRET })).toBe(false);
    expect(isLoadTestRequest(headers(SECRET), { APP_ENV: "staging", LOADTEST_BYPASS_SECRET: undefined })).toBe(false);
    expect(isLoadTestRequest(headers(), { APP_ENV: "staging", LOADTEST_BYPASS_SECRET: SECRET })).toBe(false);
    expect(isLoadTestRequest(headers(""), { APP_ENV: "staging", LOADTEST_BYPASS_SECRET: SECRET })).toBe(false);
    expect(isLoadTestRequest(headers(SECRET.slice(1)), { APP_ENV: "staging", LOADTEST_BYPASS_SECRET: SECRET })).toBe(false);
    expect(isLoadTestRequest(headers(`${SECRET}x`), { APP_ENV: "staging", LOADTEST_BYPASS_SECRET: SECRET })).toBe(false);
  });
});

describe("LOADTEST_BYPASS_SECRET at startup", () => {
  const deployed = (appEnv: string, secret: string) => parseEnv({ APP_ENV: appEnv, SITE_URL: "https://staging.joutiya.ma", LOADTEST_BYPASS_SECRET: secret }).errors;

  it("is refused in production and when weak", () => {
    expect(deployed("prod", SECRET)).toContain("LOADTEST_BYPASS_SECRET must not be set in prod");
    expect(deployed("staging", "short")).toContain("LOADTEST_BYPASS_SECRET must be 32 to 128 letters and digits");
    expect(deployed("staging", SECRET).filter((error) => error.includes("LOADTEST"))).toEqual([]);
  });
});
