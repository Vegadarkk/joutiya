import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirebaseConfigured: () => configured.value, db: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/decisions/repository", () => ({ listDueSuspensions: vi.fn() }));
vi.mock("@/lib/decisions/sanctions", () => ({ liftSuspension: vi.fn() }));

const { listDueSuspensions } = await import("@/lib/decisions/repository");
const { liftSuspension } = await import("@/lib/decisions/sanctions");
const { liftSuspensions, LIFT_BATCH } = await import("@/worker/jobs/lift-suspensions");
const { median } = await import("@/lib/decisions/stats");

// D14 lift-suspensions (hourly) and the D24 stats median.

const NOW = new Date("2026-10-16T10:35:00.000Z");
const due = (uid: string) => ({ uid, suspension: { until: new Date(NOW.getTime() - 1000), decisionId: "D".repeat(20), createdAt: NOW } });

beforeEach(() => {
  configured.value = true;
  vi.mocked(listDueSuspensions).mockReset();
  vi.mocked(liftSuspension).mockReset();
});

describe("lift-suspensions", () => {
  it("lifts each ended suspension as the system, counting failures without stopping", async () => {
    vi.mocked(listDueSuspensions).mockResolvedValue([due("a"), due("b"), due("c")]);
    vi.mocked(liftSuspension).mockImplementation(async (uid) => {
      if (uid === "b") throw new Error("auth down");
      return uid === "a";
    });
    expect(await liftSuspensions(NOW)).toEqual({ lifted: 1, failed: 1 });
    expect(listDueSuspensions).toHaveBeenCalledWith(NOW, LIFT_BATCH);
    expect(liftSuspension).toHaveBeenCalledWith("a", { now: NOW, actor: { uid: "system", role: "system" } });
    expect(liftSuspension).toHaveBeenCalledTimes(3);
  });

  it("does nothing without Firebase", async () => {
    configured.value = false;
    expect(await liftSuspensions(NOW)).toEqual({ lifted: 0, failed: 0 });
    expect(listDueSuspensions).not.toHaveBeenCalled();
  });

  it("is registered as an hourly job of the system queue", async () => {
    const { JOBS, SCHEDULES } = await import("@/worker/jobs");
    expect(JOBS["lift-suspensions"]).toBeTypeOf("function");
    expect(SCHEDULES["lift-suspensions-hourly"]).toEqual({ pattern: "35 * * * *", job: "lift-suspensions" });
  });
});

describe("stats median", () => {
  it("is null without values, the middle value or the mean of the two middle ones, rounded to 0.1", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([0.04, 0.12])).toBe(0.1);
  });
});
