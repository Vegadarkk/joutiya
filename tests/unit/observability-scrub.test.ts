import { describe, expect, it } from "vitest";
import { BREADCRUMB_DATA_LIMIT, RESTRICTED_DATA_COLLECTION, scrubEvent, type ScrubbableEvent } from "@/lib/observability/scrub";

describe("scrubEvent", () => {
  it("removes credentials from request headers and drops cookies, bodies and query strings", () => {
    const event: ScrubbableEvent = {
      request: {
        headers: { Cookie: "__Host-session=abc", authorization: "Bearer t", "X-CSRF-Token": "c", "x-hub-signature-256": "s", "svix-signature": "v", "cf-connecting-ip": "1.2.3.4", host: "joutiya.ma", accept: "*/*" },
        cookies: { "__Host-session": "abc" },
        data: { password: "p" },
        query_string: "token=1",
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed?.request).toEqual({ headers: { host: "joutiya.ma", accept: "*/*" } });
    // Pure: the SDK's own event object is left alone.
    expect(event.request?.cookies).toEqual({ "__Host-session": "abc" });
    expect(event.request?.headers?.Cookie).toBe("__Host-session=abc");
  });

  it("keeps only the user id", () => {
    expect(scrubEvent({ user: { id: "u1", email: "a@b.ma", ip_address: "1.2.3.4" } as ScrubbableEvent["user"] })).toEqual({ user: { id: "u1" } });
    expect(scrubEvent({ user: { email: "a@b.ma" } as ScrubbableEvent["user"] })).toEqual({});
  });

  it("drops Next.js control-flow errors", () => {
    expect(scrubEvent({ exception: { values: [{ type: "Error", value: "NEXT_REDIRECT;replace;/fr;307;" }] } })).toBeNull();
    expect(scrubEvent({ exception: { values: [{ type: "Error", value: "NEXT_HTTP_ERROR_FALLBACK;404" }] } })).toBeNull();
    expect(scrubEvent({ message: "NEXT_NOT_FOUND" })).toBeNull();
    expect(scrubEvent({ exception: { values: [{ type: "TypeError", value: "boom" }] } })).not.toBeNull();
  });

  it("truncates breadcrumb data over 1 KB and keeps small data as is", () => {
    const small = { url: "/api/health", status: 200 };
    const scrubbed = scrubEvent({ breadcrumbs: [{ data: small }, { data: { blob: "x".repeat(5_000) } }, {}] });
    expect(scrubbed?.breadcrumbs?.[0]?.data).toBe(small);
    const truncated = scrubbed?.breadcrumbs?.[1]?.data as unknown as { truncated: string };
    expect(truncated.truncated.length).toBeLessThanOrEqual(BREADCRUMB_DATA_LIMIT + 1);
    expect(truncated.truncated.startsWith('{"blob":"xxx')).toBe(true);
    expect(scrubbed?.breadcrumbs?.[2]).toEqual({});
  });

  it("leaves events without request, user or breadcrumbs untouched", () => {
    const event = { message: "boom", tags: { service: "web" } };
    expect(scrubEvent(event)).toEqual(event);
  });
});

describe("RESTRICTED_DATA_COLLECTION", () => {
  it("collects no personal data, IP, cookie, header, body or query string", () => {
    expect(RESTRICTED_DATA_COLLECTION).toEqual({
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
    });
  });
});
