"use client";

import { useEffect } from "react";
import { usePublicConfig } from "@/lib/config/client";
import { RESTRICTED_DATA_COLLECTION, scrubEvent } from "@/lib/observability/scrub";

// Browser error tracking (§2). The DSN arrives with the runtime configuration (no NEXT_PUBLIC_*),
// so the SDK chunk loads lazily, once per page load, and only when a DSN is configured. Errors
// only: no tracing, replay or feedback (free plan, no personal data). Envelopes are posted to the
// DSN origin, which src/proxy.ts adds to connect-src; no tunnel.

let started = false;

export function SentryClient(): null {
  const sentry = usePublicConfig()?.sentry ?? null;
  useEffect(() => {
    if (!sentry?.dsn || started) return;
    started = true;
    import("@sentry/browser")
      .then((Sentry) => {
        Sentry.init({
          dsn: sentry.dsn,
          environment: sentry.environment,
          release: sentry.release,
          sampleRate: 1,
          maxBreadcrumbs: 30,
          dataCollection: RESTRICTED_DATA_COLLECTION,
          beforeSend: scrubEvent,
          // Errors raised by our own scripts only (browser extensions and third-party embeds stay out).
          allowUrls: [window.location.origin],
        });
      })
      .catch(() => {
        // Chunk not loaded (offline, blocked): the next mount may try again.
        started = false;
      });
  }, [sentry]);
  return null;
}
