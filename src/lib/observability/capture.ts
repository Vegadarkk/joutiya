import "server-only";
import { logger } from "@/lib/logging/logger";

// Error capture seam: the Sentry integration (src/lib/observability/sentry-server.ts) replaces the
// handler at startup; without it, errors are only logged. Never throws.

export type ExceptionHandler = (error: unknown, context?: Record<string, unknown>) => void;

let handler: ExceptionHandler | undefined;

export function setExceptionHandler(next: ExceptionHandler | undefined): void {
  handler = next;
}

export function captureServerException(error: unknown, context: Record<string, unknown> = {}): void {
  try {
    const err = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
    logger.error({ err, ...context }, "unhandled error");
    handler?.(error, context);
  } catch {
    // Reporting must never fail the request.
  }
}
