import { beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({ setTransactionName: vi.fn(), setTags: vi.fn(), setExtra: vi.fn() }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), withScope: vi.fn() }));
vi.mock("@sentry/node", () => sentry);

import { captureRequestError, errorDigest, isControlFlowError } from "@/lib/observability/request-error";

const request = { method: "GET", path: "/api/listings?token=secret-token" };
const context = { routerKind: "App Router", routePath: "/api/listings", routeType: "route" };

beforeEach(() => {
  for (const fn of [...Object.values(scope), ...Object.values(sentry)]) fn.mockReset();
  sentry.withScope.mockImplementation((callback: (s: typeof scope) => unknown) => callback(scope));
});

describe("isControlFlowError", () => {
  it("recognises redirect() and notFound() by their digest", () => {
    expect(isControlFlowError(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/fr/connexion;307;" }))).toBe(true);
    expect(isControlFlowError(Object.assign(new Error(""), { digest: "NEXT_NOT_FOUND" }))).toBe(true);
    expect(isControlFlowError(Object.assign(new Error(""), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }))).toBe(true);
    expect(isControlFlowError(Object.assign(new Error("boom"), { digest: "1234567890" }))).toBe(false);
    expect(isControlFlowError(new Error("boom"))).toBe(false);
    expect(isControlFlowError("string error")).toBe(false);
    expect(errorDigest({ digest: 42 })).toBe("");
  });
});

describe("captureRequestError", () => {
  it("skips control-flow errors", () => {
    captureRequestError(Object.assign(new Error(""), { digest: "NEXT_REDIRECT;push;/fr;307;" }), request, context);
    expect(sentry.withScope).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("sends the route identity only, with the path stripped of its query", () => {
    const error = new Error("boom");
    captureRequestError(error, request, context);
    expect(scope.setTransactionName).toHaveBeenCalledWith("GET /api/listings");
    expect(scope.setTags).toHaveBeenCalledWith({ method: "GET", routePath: "/api/listings", routerKind: "App Router", routeType: "route" });
    expect(scope.setExtra).toHaveBeenCalledWith("path", "/api/listings");
    expect(sentry.captureException).toHaveBeenCalledWith(error, { mechanism: { handled: false, type: "auto.function.nextjs.on_request_error" } });
    const everything = JSON.stringify([...Object.values(scope), ...Object.values(sentry)].map((fn) => fn.mock.calls));
    expect(everything).not.toContain("secret-token");
    expect(everything).not.toMatch(/cookie|authorization/i);
  });
});
