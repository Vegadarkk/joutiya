import "server-only";
import * as Sentry from "@sentry/node";
import { serverEnv } from "@/lib/env";
import { consume, isDegraded } from "@/lib/quota";
import { setExceptionHandler } from "./capture";
import { RESTRICTED_DATA_COLLECTION, scrubBreadcrumb, scrubEvent, type ScrubbableEvent } from "./scrub";

// Error tracking of `web` and `worker` (§2: Sentry, EU region, free plan). Errors only: no
// tracing (`tracesSampleRate` stays unset, 0 would not disable it), no replay, no profiling, and
// no sentry-trace/baggage headers on outgoing requests (third parties never see a trace id).
// Collection is restricted, every breadcrumb passes through scrubBreadcrumb and every event
// through scrubEvent, then counts against the month's free quota (sentry.events, shared by both
// services through valkey-queue): once it is degraded, events are dropped here until the month
// ends and the pino logs remain. Without SENTRY_DSN the module is inert: errors are only logged
// by src/lib/observability/capture.ts.

export type Service = "web" | "worker";

/** Free quota of the month (src/config/quotas.ts): a crashing page must not spend it in an hour. */
const EVENTS_QUOTA = "sentry.events";

let active = false;
/** Cached level of the quota: beforeSend is synchronous and never waits for Valkey. */
let eventsDegraded = false;

/** One event counted, fire-and-forget; the level comes back with the count (unknown counts as available). */
function countEvent(): void {
  void consume(EVENTS_QUOTA)
    .then((current) => {
      eventsDegraded = current.level === "degraded";
    })
    .catch(() => undefined);
}

/**
 * `beforeSend` of the server SDK: the scrubbed event, counted against the quota; null for a
 * control-flow error, or for every event once the quota is degraded (nothing counted then).
 */
export function beforeSendServerEvent<T extends ScrubbableEvent>(event: T): T | null {
  const scrubbed = scrubEvent(event);
  if (!scrubbed || eventsDegraded) return null;
  countEvent();
  return scrubbed;
}

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
    beforeSend: beforeSendServerEvent,
  });
  Sentry.setTag("service", service);
  setExceptionHandler((error, context) => {
    Sentry.captureException(error, { extra: context });
  });
  active = true;
  // A restart in a spent month starts dropping at once (fire-and-forget: init stays synchronous).
  void isDegraded(EVENTS_QUOTA)
    .then((degraded) => {
      eventsDegraded = degraded;
    })
    .catch(() => undefined);
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
