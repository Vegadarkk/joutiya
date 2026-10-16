import type { Instrumentation } from "next";

// Runs once when the Next.js server starts, before it serves requests, and receives every
// unhandled request error (onRequestError). This file is bundled for the edge runtime too, so
// @sentry/node and the startup checks are imported lazily and only on Node.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("./lib/startup/checks");
  await runStartupChecks("web");
  const { initServerObservability } = await import("./lib/observability/sentry-server");
  initServerObservability("web");
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureRequestError } = await import("./lib/observability/request-error");
  // Only the route identity: request.headers (cookies, authorization) stay here.
  captureRequestError(
    error,
    { method: request.method, path: request.path },
    { routerKind: context.routerKind, routePath: context.routePath, routeType: context.routeType },
  );
};
