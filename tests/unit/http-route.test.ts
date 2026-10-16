import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// apiRoute (src/lib/http/route.ts): typed errors answer as themselves, a Firestore refusal on a
// spent Spark quota (gRPC 8 RESOURCE_EXHAUSTED) answers like a degraded quota (503
// quota_exhausted, Retry-After at the reset) and is still reported, anything else is a bare 500.

vi.mock("@/lib/observability/capture", () => ({ captureServerException: vi.fn() }));

const { captureServerException } = await import("@/lib/observability/capture");
const { apiRoute } = await import("@/lib/http/route");
const { HttpError } = await import("@/lib/http/errors");

const context = { params: Promise.resolve({}) };
const request = () => new NextRequest("http://localhost:3000/api/listings/abcd2345", { method: "PATCH" });

async function answer(error: unknown): Promise<{ response: Response; body: { error: { code: string; message?: string } } }> {
  const response = await apiRoute(() => {
    throw error;
  })(request(), context);
  return { response, body: (await response.json()) as { error: { code: string; message?: string } } };
}

beforeEach(() => {
  vi.mocked(captureServerException).mockClear();
});

describe("apiRoute", () => {
  it("answers a Firestore RESOURCE_EXHAUSTED with the quota 503 and reports it", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T05:00:00Z"), toFake: ["Date"] });
    try {
      const refusal = Object.assign(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."), { code: 8 });
      const { response, body } = await answer(refusal);
      expect(response.status).toBe(503);
      expect(body.error.code).toBe("quota_exhausted");
      // PDT in October: Firestore resets at 07:00 UTC, two hours later.
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(2 * 3600);
      expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(2 * 3600 + 1);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(captureServerException).toHaveBeenCalledWith(refusal, { route: "/api/listings/abcd2345", method: "PATCH" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers any other failure with a bare 500, reported", async () => {
    for (const error of [new Error("boom"), Object.assign(new Error("14 UNAVAILABLE"), { code: 14 })]) {
      const { response, body } = await answer(error);
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: { code: "internal" } });
      expect(captureServerException).toHaveBeenLastCalledWith(error, expect.objectContaining({ route: "/api/listings/abcd2345" }));
    }
  });

  it("answers typed errors as they are, without reporting them", async () => {
    const { response, body } = await answer(new HttpError(409, "conflict", "version mismatch"));
    expect(response.status).toBe(409);
    expect(body.error).toEqual({ code: "conflict", message: "version mismatch" });
    expect(captureServerException).not.toHaveBeenCalled();
  });

  it("keeps a successful answer and marks it no-store", async () => {
    const response = await apiRoute(() => Response.json({ ok: true }))(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
