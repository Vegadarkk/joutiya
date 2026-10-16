// Event scrubbing shared by the server (@sentry/node) and the browser (@sentry/browser) SDKs as
// `beforeSend`. Pure and free of Node imports: a client component and the unit tests import it.
// Belt and braces with `dataCollection` below: whatever an integration still attaches is removed.

import type { BrowserOptions } from "@sentry/browser";

/** The event fields the scrubber reads or rewrites (structural subset of Sentry's ErrorEvent). */
export interface ScrubbableEvent {
  message?: string;
  exception?: { values?: { type?: string; value?: string }[] };
  request?: { headers?: Record<string, string>; cookies?: Record<string, string>; data?: unknown; query_string?: unknown };
  user?: { id?: string | number };
  breadcrumbs?: { data?: Record<string, unknown> }[];
}

export type DataCollection = NonNullable<BrowserOptions["dataCollection"]>;

/**
 * Sentry v11 collects everything by default (`sendDefaultPii` is gone, `dataCollection` replaces
 * it). No personal data, no IP addresses, no cookies, no headers, no bodies, no query strings.
 */
export const RESTRICTED_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  stackFrameVariables: false,
};

/** Request headers that never reach Sentry (lower case; matched case-insensitively). */
export const DENIED_HEADERS: ReadonlySet<string> = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-csrf-token",
  "x-hub-signature-256",
  "svix-signature",
  "x-joutiya-signature",
  "cf-access-jwt-assertion",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
]);

/** Next.js control flow (redirect(), notFound(), forbidden()...) surfaces as thrown errors: not errors. */
export const CONTROL_FLOW_PATTERN = /NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK/;

/** Breadcrumb `data` above this many JSON characters is cut (payload cap is 1 MB per event). */
export const BREADCRUMB_DATA_LIMIT = 1024;

function isControlFlow(event: ScrubbableEvent): boolean {
  if (event.message && CONTROL_FLOW_PATTERN.test(event.message)) return true;
  return (event.exception?.values ?? []).some((value) => typeof value.value === "string" && CONTROL_FLOW_PATTERN.test(value.value));
}

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !DENIED_HEADERS.has(name.toLowerCase())));
}

function truncateData(data: Record<string, unknown>): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(data) ?? "";
  } catch {
    return { truncated: "[unserializable]" };
  }
  return json.length > BREADCRUMB_DATA_LIMIT ? { truncated: `${json.slice(0, BREADCRUMB_DATA_LIMIT)}…` } : data;
}

/**
 * Returns a scrubbed copy of the event, or null to drop it. Never mutates its input and never
 * throws (a scrubber that throws would lose the event).
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T | null {
  if (isControlFlow(event)) return null;
  const result: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };

  if (event.request) {
    const request: ScrubbableEvent["request"] = { ...event.request };
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (request.headers) request.headers = scrubHeaders(request.headers);
    result.request = request;
  }

  if (event.user) {
    if (event.user.id === undefined) delete result.user;
    else result.user = { id: event.user.id };
  }

  if (event.breadcrumbs) {
    result.breadcrumbs = event.breadcrumbs.map((crumb) => (crumb.data ? { ...crumb, data: truncateData(crumb.data) } : crumb));
  }

  return result as T;
}
