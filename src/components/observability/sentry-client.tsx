"use client";

import { useEffect } from "react";
import { whenIdle } from "@/lib/browser/when-idle";
import { usePublicConfig } from "@/lib/config/client";

// Browser error tracking (§2). The DSN arrives with the runtime configuration (no NEXT_PUBLIC_*),
// so the SDK chunk loads lazily, once per page load, and only when a DSN is configured. Errors
// only: no tracing, replay or feedback (free plan, no personal data), no trace headers on fetch
// calls. Envelopes are posted to the DSN origin, which src/proxy.ts adds to connect-src; no tunnel.
// The chunk (sentry-browser.ts: `init` and the scrubbers) loads once the main thread is idle, so it
// does not compete with the first paint and hydration.

let started = false;

export function SentryClient(): null {
  const sentry = usePublicConfig()?.sentry ?? null;
  useEffect(() => {
    if (!sentry?.dsn || started) return;
    started = true;
    whenIdle(() => {
      import("@/lib/observability/sentry-browser")
        .then(({ startBrowserSentry }) => startBrowserSentry(sentry))
        .catch(() => {
          // Chunk not loaded (offline, blocked): the next mount may try again.
          started = false;
        });
    });
  }, [sentry]);
  return null;
}
