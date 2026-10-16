import "server-only";
import type { NextRequest } from "next/server";
import { captureServerException } from "@/lib/observability/capture";
import { fromResourceExhausted } from "@/lib/quota/gate";
import { HttpError } from "./errors";

// Route handler wrapper: typed errors become JSON problem responses, anything else is logged,
// reported and answered 500 without detail. API responses are never cached.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
export type RouteHandler = (request: NextRequest, context: RouteContext) => Promise<Response> | Response;

export function apiRoute(handler: RouteHandler): (request: NextRequest, context: RouteContext) => Promise<Response> {
  return async (request, context) => {
    try {
      const response = await handler(request, context);
      if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse();
      // Reported either way: a Spark refusal (RESOURCE_EXHAUSTED) the counters missed raised no
      // quota alert. It answers like a degraded quota (503 quota_exhausted until the reset).
      captureServerException(error, { route: new URL(request.url).pathname, method: request.method });
      return (fromResourceExhausted(error) ?? new HttpError(500, "internal")).toResponse();
    }
  };
}

/** JSON response with no-store caching. */
export function json<T>(body: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
