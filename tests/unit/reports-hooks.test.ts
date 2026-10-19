import { afterEach, describe, expect, it, vi } from "vitest";

// The reports lot's triage hook (design D10, D19; audit D1b-01): by default a new report queues a
// `report_triage` task for the agent; a queue failure is logged, never thrown; tests may replace it.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/ai", () => ({ enqueueAiTask: vi.fn(async () => ({ queued: true })) }));

const { enqueueAiTask } = await import("@/lib/ai");
const { logger } = await import("@/lib/logging/logger");
const { requestTriage, setTriageRequester } = await import("@/lib/reports/hooks");

afterEach(() => setTriageRequester(undefined));

describe("requestTriage", () => {
  it("queues a report_triage task on the agent queue by default", async () => {
    await requestTriage("r1");
    expect(enqueueAiTask).toHaveBeenCalledExactlyOnceWith("report_triage", { type: "report", id: "r1" });
  });

  it("never throws when the queue is down", async () => {
    vi.mocked(enqueueAiTask).mockRejectedValueOnce(new Error("agent job not enqueued in time"));
    await expect(requestTriage("r2")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reportId: "r2" }), "reports: triage request failed");
  });

  it("can be replaced in tests and restored", async () => {
    const spy = vi.fn(async () => undefined);
    setTriageRequester(spy);
    await requestTriage("r3");
    expect(spy).toHaveBeenCalledExactlyOnceWith("r3");
    setTriageRequester(undefined);
    await requestTriage("r4");
    expect(enqueueAiTask).toHaveBeenCalledWith("report_triage", { type: "report", id: "r4" });
  });
});
