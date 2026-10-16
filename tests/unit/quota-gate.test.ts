import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";

vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));

const { firstDegraded } = await import("@/lib/quota");
const { HttpError } = await import("@/lib/http/errors");
const { assertQuotas, fromResourceExhausted, isResourceExhausted, quotaUnavailable, retryAfterSeconds, DEPOSIT_QUOTAS, PUBLIC_READ_QUOTAS, QUOTA_ERROR_CODE, SIGNUP_QUOTAS } = await import("@/lib/quota/gate");

beforeEach(() => {
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

describe("quota gate", () => {
  it("names the quotas each degraded mode watches (src/config/quotas.ts degradedMode)", () => {
    expect(DEPOSIT_QUOTAS).toEqual(["firestore.writes"]);
    expect(SIGNUP_QUOTAS).toEqual(["firestore.writes"]);
    expect(PUBLIC_READ_QUOTAS).toEqual(["firestore.reads"]);
  });

  it("lets the request through while no quota of the list is degraded", async () => {
    await expect(assertQuotas(DEPOSIT_QUOTAS)).resolves.toBeUndefined();
    expect(firstDegraded).toHaveBeenCalledWith(DEPOSIT_QUOTAS);
  });

  it("answers 503 with a Retry-After until the provider's reset", async () => {
    // Its own code: clients neither retry it like "unavailable" nor show a generic error.
    expect(QUOTA_ERROR_CODE).toBe("quota_exhausted");
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    const refusal = await assertQuotas(SIGNUP_QUOTAS).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HttpError);
    expect(refusal).toMatchObject({ status: 503, code: QUOTA_ERROR_CODE });
    const response = (refusal as InstanceType<typeof HttpError>).toResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(60);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(QUOTA_ERROR_CODE);
  });

  it("waits for the Pacific midnight on Firestore, at least a minute", () => {
    // PDT in October: Firestore resets at 07:00 UTC.
    expect(retryAfterSeconds("firestore.writes", new Date("2026-10-16T05:00:00Z"))).toBeGreaterThanOrEqual(2 * 3600);
    expect(retryAfterSeconds("firestore.writes", new Date("2026-10-16T05:00:00Z"))).toBeLessThanOrEqual(2 * 3600 + 1);
    expect(retryAfterSeconds("firestore.writes", new Date("2026-10-16T06:59:59.500Z"))).toBe(60);
    // nextReset is found to the second, at or just after the boundary.
    const nextDay = Number(quotaUnavailable("firestore.reads", new Date("2026-10-16T08:00:00Z")).headers?.["Retry-After"]);
    expect(nextDay).toBeGreaterThanOrEqual(23 * 3600);
    expect(nextDay).toBeLessThanOrEqual(23 * 3600 + 1);
  });

  it("turns a Firestore RESOURCE_EXHAUSTED into the same 503, and nothing else", () => {
    const exhausted = Object.assign(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."), { code: 8 });
    expect(isResourceExhausted(exhausted)).toBe(true);
    for (const other of [new Error("boom"), Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }), { code: "auth/user-not-found" }, null, "8"]) {
      expect(isResourceExhausted(other)).toBe(false);
      expect(fromResourceExhausted(other)).toBeNull();
    }
    const refusal = fromResourceExhausted(exhausted, new Date("2026-10-16T05:00:00Z"));
    expect(refusal).toMatchObject({ status: 503, code: QUOTA_ERROR_CODE });
    expect(Number(refusal?.headers?.["Retry-After"])).toBeGreaterThanOrEqual(2 * 3600);
  });
});
