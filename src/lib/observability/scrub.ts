// Event scrubbing shared by the server (@sentry/node) and the browser (@sentry/browser) SDKs as
// `beforeSend` and `beforeBreadcrumb`. Pure and free of Node imports: a client component and the
// unit tests import it. Belt and braces with `dataCollection` below: whatever an integration still
// attaches is removed.

import type { BrowserOptions } from "@sentry/browser";

/** The breadcrumb fields the scrubber reads or rewrites (structural subset of Sentry's Breadcrumb). */
export interface ScrubbableBreadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** The event fields the scrubber reads or rewrites (structural subset of Sentry's ErrorEvent). */
export interface ScrubbableEvent {
  message?: string;
  exception?: { values?: { type?: string; value?: string }[] };
  request?: { url?: string; headers?: Record<string, string>; cookies?: Record<string, string>; data?: unknown; query_string?: unknown };
  user?: { id?: string | number };
  breadcrumbs?: ScrubbableBreadcrumb[];
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

/** A bot token in a URL path (Telegram Bot API: https://api.telegram.org/bot<token>/sendMessage). */
const BOT_TOKEN_PATTERN = /\/bot[^/\s]+/g;
/** E-mail addresses: a provider error may echo the recipient, and Sentry holds no personal data. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Breadcrumb data fields that carry a URL (http, fetch, xhr and navigation breadcrumbs). */
const URL_FIELDS = ["url", "to", "from"] as const;

/** The URL without its query string and fragment (?oobCode=, ?key=...), any bot token hidden. */
export function redactUrl(url: string): string {
  return (url.split(/[?#]/, 1)[0] ?? url).replace(BOT_TOKEN_PATTERN, "/bot[redacted]");
}

/** Free text (messages, exception values) without e-mail addresses or bot tokens. */
export function redactText(text: string): string {
  return text.replace(BOT_TOKEN_PATTERN, "/bot[redacted]").replace(EMAIL_PATTERN, "[email]");
}

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
 * `beforeBreadcrumb` of both SDKs, also applied by scrubEvent to the breadcrumbs an event carries:
 * URLs lose their query, fragment and bot token (the http integrations record outgoing requests,
 * Telegram's included), the separate query and fragment fields go, data is capped. Never mutates.
 */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  const result: ScrubbableBreadcrumb = { ...crumb };
  if (typeof crumb.message === "string") result.message = redactText(crumb.message);
  if (crumb.data) {
    const data = { ...crumb.data };
    for (const field of URL_FIELDS) {
      const value = data[field];
      if (typeof value === "string") data[field] = redactUrl(value);
    }
    delete data["http.query"];
    delete data["http.fragment"];
    result.data = truncateData(data);
  }
  return result as T;
}

/**
 * Returns a scrubbed copy of the event, or null to drop it. Never mutates its input and never
 * throws (a scrubber that throws would lose the event).
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T | null {
  if (isControlFlow(event)) return null;
  const result: ScrubbableEvent = { ...event };

  if (typeof event.message === "string") result.message = redactText(event.message);
  if (event.exception?.values) {
    const values = event.exception.values.map((value) => (typeof value.value === "string" ? { ...value, value: redactText(value.value) } : value));
    result.exception = { ...event.exception, values };
  }

  if (event.request) {
    const request: ScrubbableEvent["request"] = { ...event.request };
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    // The SDK keeps the query out (urlQueryParams: false); the URL itself is cut here as well.
    if (typeof request.url === "string") request.url = redactUrl(request.url);
    if (request.headers) request.headers = scrubHeaders(request.headers);
    result.request = request;
  }

  if (event.user) {
    if (event.user.id === undefined) delete result.user;
    else result.user = { id: event.user.id };
  }

  if (event.breadcrumbs) result.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

  return result as T;
}
