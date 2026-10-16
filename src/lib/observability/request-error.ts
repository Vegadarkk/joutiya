import "server-only";
import * as Sentry from "@sentry/node";
import { CONTROL_FLOW_PATTERN } from "./scrub";

// Next.js onRequestError → Sentry (src/instrumentation.ts). Only the route identity reaches
// Sentry: method, path without query, route path, router kind, route type. Request headers
// (cookies, authorization) never leave the process. Next's control-flow "errors" (redirect(),
// notFound()...) are recognised by their digest and skipped.

export interface RequestErrorRequest {
  method: string;
  path: string;
}

export interface RequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
}

export function errorDigest(error: unknown): string {
  if (typeof error !== "object" || error === null || !("digest" in error)) return "";
  const { digest } = error as { digest?: unknown };
  return typeof digest === "string" ? digest : "";
}

export function isControlFlowError(error: unknown): boolean {
  const digest = errorDigest(error);
  return digest !== "" && CONTROL_FLOW_PATTERN.test(digest.split(";")[0] ?? digest);
}

/** Without a client (no DSN) Sentry.captureException is a no-op, so this is always safe to call. */
export function captureRequestError(error: unknown, request: RequestErrorRequest, context: RequestErrorContext): void {
  if (isControlFlowError(error)) return;
  const path = request.path.split("?")[0] ?? request.path;
  Sentry.withScope((scope) => {
    scope.setTransactionName(`${request.method} ${context.routePath}`);
    scope.setTags({ method: request.method, routePath: context.routePath, routerKind: context.routerKind, routeType: context.routeType });
    scope.setExtra("path", path);
    Sentry.captureException(error, { mechanism: { handled: false, type: "auto.function.nextjs.on_request_error" } });
  });
}
