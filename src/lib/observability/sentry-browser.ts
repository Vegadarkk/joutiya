import { init } from "@sentry/browser";
import type { PublicConfig } from "@/lib/config/public-types";
import { RESTRICTED_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "./scrub";

// The browser SDK as the app uses it: `init` with its default integrations, errors only (§2). Its
// own chunk, loaded by SentryClient: importing the package namespace instead would keep every
// export (replay, feedback, tracing; ~160 KB compressed) in that chunk.
// Browser events are not counted against the sentry.events quota (src/config/quotas.ts): they go
// straight to Sentry without a server hop, and the free plan refuses events above the quota
// without billing. Only the server SDK counts and drops (sentry-server.ts).

export function startBrowserSentry({ dsn, environment, release }: NonNullable<PublicConfig["sentry"]>): void {
  init({
    dsn,
    environment,
    release,
    sampleRate: 1,
    maxBreadcrumbs: 30,
    tracePropagationTargets: [],
    dataCollection: RESTRICTED_DATA_COLLECTION,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
    // Errors raised by our own scripts only (browser extensions and third-party embeds stay out).
    allowUrls: [window.location.origin],
  });
}
