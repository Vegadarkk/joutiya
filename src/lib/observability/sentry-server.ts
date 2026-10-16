import "server-only";
import * as Sentry from "@sentry/node";
import { serverEnv } from "@/lib/env";
import { setExceptionHandler } from "./capture";
import { RESTRICTED_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "./scrub";

// Error tracking of `web` and `worker` (§2: Sentry, EU region, free plan). Errors only: no
// tracing (`tracesSampleRate` stays unset, 0 would not disable it), no replay, no profiling, and
// no sentry-trace/baggage headers on outgoing requests (third parties never see a trace id).
// Collection is restricted, every breadcrumb passes through scrubBreadcrumb and every event
// through scrubEvent. Without SENTRY_DSN the module is inert: errors are only logged by
// src/lib/observability/capture.ts.

export type Service = "web" | "worker";

let active = false;

export function initServerObservability(service: Service): void {
  if (active) return;
  const env = serverEnv();
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    release: env.RELEASE,
    serverName: service,
    sampleRate: 1,
    maxBreadcrumbs: 30,
    tracePropagationTargets: [],
    dataCollection: RESTRICTED_DATA_COLLECTION,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
  });
  Sentry.setTag("service", service);
  setExceptionHandler((error, context) => {
    Sentry.captureException(error, { extra: context });
  });
  active = true;
}

/** True once Sentry.init ran in this process. */
export function observabilityActive(): boolean {
  return active;
}

/** Lets queued events leave before the process exits (worker shutdown). Never throws. */
export async function flushObservability(timeoutMs = 2_000): Promise<void> {
  if (!active) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Best effort: shutdown must not wait on Sentry.
  }
}
