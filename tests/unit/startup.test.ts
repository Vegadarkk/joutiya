import { describe, expect, it } from "vitest";
import { startupReport } from "@/lib/startup/checks";

describe("startupReport", () => {
  it("lets a development server start", async () => {
    expect((await startupReport("web", {})).fatal).toEqual([]);
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
});
