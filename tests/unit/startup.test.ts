import { describe, expect, it } from "vitest";
import { isLocalHost, startupReport } from "@/lib/startup/checks";

const DEV_HOST_PROBLEM = /^APP_ENV=dev serves local hosts only, not SITE_URL host /;

describe("startupReport", () => {
  it("lets a development server start", async () => {
    expect((await startupReport("web", {})).fatal).toEqual([]);
  });

  it("refuses APP_ENV=dev (set or defaulted) on a host that is not local", async () => {
    // dev enables the x-dev-access-email bypass and skips every deployed check.
    const explicit = await startupReport("web", { APP_ENV: "dev", SITE_URL: "https://joutiya.ma" });
    expect(explicit.fatal).toHaveLength(1);
    expect(explicit.fatal[0]).toMatch(DEV_HOST_PROBLEM);
    expect(explicit.fatal[0]).toContain("joutiya.ma");
    const defaulted = await startupReport("worker", { SITE_URL: "https://staging.joutiya.ma" });
    expect(defaulted.fatal.some((problem) => DEV_HOST_PROBLEM.test(problem))).toBe(true);
    // A public IP is not local either.
    expect((await startupReport("web", { APP_ENV: "dev", SITE_URL: "http://203.0.113.9:3000" })).fatal.some((problem) => DEV_HOST_PROBLEM.test(problem))).toBe(true);
  });

  it("lets a development server serve localhost, *.localhost, loopback and private addresses", async () => {
    for (const site of [
      "http://localhost:3000",
      "http://admin.localhost:3100",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://10.0.0.5:3000",
      "http://172.20.1.2",
      "http://192.168.1.10:3000",
    ]) {
      expect((await startupReport("web", { APP_ENV: "dev", SITE_URL: site })).fatal, site).toEqual([]);
    }
    // Staging and production are not concerned by this check (they have their own).
    expect((await startupReport("web", { APP_ENV: "staging", SITE_URL: "https://staging.joutiya.ma" })).fatal.some((problem) => DEV_HOST_PROBLEM.test(problem))).toBe(false);
  });

  it("tells local hosts from public ones", () => {
    expect(isLocalHost("LOCALHOST")).toBe(true);
    expect(isLocalHost("admin.localhost.")).toBe(true);
    expect(isLocalHost("172.16.0.1")).toBe(true);
    expect(isLocalHost("172.31.255.255")).toBe(true);
    expect(isLocalHost("172.32.0.1")).toBe(false);
    expect(isLocalHost("172.15.0.1")).toBe(false);
    expect(isLocalHost("192.169.0.1")).toBe(false);
    expect(isLocalHost("joutiya.ma")).toBe(false);
    expect(isLocalHost("localhost.joutiya.ma")).toBe(false);
    expect(isLocalHost("8.8.8.8")).toBe(false);
  });

  it("refuses to start a deployed server without its environment, targets and CSP hook", async () => {
    const { fatal } = await startupReport("web", { APP_ENV: "staging" });
    expect(fatal).toContain("QUEUE_REDIS_URL is required when APP_ENV=staging");
    expect(fatal.some((problem) => problem.startsWith("CSP hash hook not loaded"))).toBe(true);
    expect(fatal.some((problem) => problem.includes("required in strict mode"))).toBe(true);
  });

  it("keeps a deployed server strict when its environment does not parse", async () => {
    // A parse failure falls back to dev defaults: the raw APP_ENV must still decide.
    const { fatal, warnings } = await startupReport("web", { APP_ENV: "staging", LOG_LEVEL: "verbose" });
    expect(fatal.some((problem) => problem.startsWith("LOG_LEVEL:"))).toBe(true);
    expect(fatal.some((problem) => problem.includes("required in strict mode"))).toBe(true);
    expect(fatal.some((problem) => problem.startsWith("CSP hash hook not loaded"))).toBe(true);
    // Recommended-but-missing variables are warnings; a parse error never is.
    expect(warnings.every((warning) => / is not set: /.test(warning))).toBe(true);
    expect((await startupReport("worker", { APP_ENV: "production" })).fatal.some((problem) => problem.startsWith("APP_ENV:"))).toBe(true);
  });

  it("does not require the CSP hook in the worker", async () => {
    const { fatal } = await startupReport("worker", { APP_ENV: "staging" });
    expect(fatal.some((problem) => problem.startsWith("CSP hash hook"))).toBe(false);
  });

  it("warns about missing object storage and stops on a partial R2 configuration", async () => {
    const missing = await startupReport("worker", { APP_ENV: "staging" });
    expect(missing.warnings).toContain("R2_BUCKET_MEDIA is not set: the feature that needs it is unavailable");
    expect(missing.warnings).toContain("BACKUP_AGE_RECIPIENT is not set: the feature that needs it is unavailable");
    expect(missing.fatal.some((problem) => problem.startsWith("R2 storage needs all of"))).toBe(false);
    const partial = await startupReport("worker", { APP_ENV: "staging", R2_BUCKET_MEDIA: "joutiya-staging-media" });
    expect(partial.fatal.some((problem) => problem.startsWith("R2 storage needs all of"))).toBe(true);
  });
});
