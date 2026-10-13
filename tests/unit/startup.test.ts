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

  it("does not require the CSP hook in the worker", async () => {
    const { fatal } = await startupReport("worker", { APP_ENV: "staging" });
    expect(fatal.some((problem) => problem.startsWith("CSP hash hook"))).toBe(false);
  });
});
