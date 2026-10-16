import { describe, expect, it } from "vitest";
import {
  BREADCRUMB_DATA_LIMIT,
  RESTRICTED_DATA_COLLECTION,
  redactText,
  redactUrl,
  scrubBreadcrumb,
  scrubEvent,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from "@/lib/observability/scrub";

// Not a real token shape: Gitleaks runs on this repository.
const BOT_URL = "https://api.telegram.org/bot123:ABC/sendMessage";

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

  it("cuts the query string and fragment off the request URL (password reset codes)", () => {
    const event: ScrubbableEvent = { request: { url: "https://joutiya.ma/fr/mot-de-passe/nouveau?mode=resetPassword&oobCode=AbC123#top" } };
    expect(scrubEvent(event)?.request).toEqual({ url: "https://joutiya.ma/fr/mot-de-passe/nouveau" });
    expect(event.request?.url).toContain("oobCode=");
  });

  it("hides e-mail addresses and bot tokens in the message and the exception values", () => {
    const event: ScrubbableEvent = {
      message: `resend: recipient buyer.1+tag@example.ma refused (${BOT_URL})`,
      exception: { values: [{ type: "Error", value: "mail to Seller@shop.co.ma bounced" }, { type: "TypeError", value: "boom" }] },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed?.message).toBe("resend: recipient [email] refused (https://api.telegram.org/bot[redacted]/sendMessage)");
    expect(scrubbed?.exception?.values).toEqual([{ type: "Error", value: "mail to [email] bounced" }, { type: "TypeError", value: "boom" }]);
    expect(event.message).toContain("buyer.1+tag@example.ma");
    expect(event.exception?.values?.[0]?.value).toContain("Seller@shop.co.ma");
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
    expect(scrubbed?.breadcrumbs?.[0]?.data).toEqual(small);
    const truncated = scrubbed?.breadcrumbs?.[1]?.data as unknown as { truncated: string };
    expect(truncated.truncated.length).toBeLessThanOrEqual(BREADCRUMB_DATA_LIMIT + 1);
    expect(truncated.truncated.startsWith('{"blob":"xxx')).toBe(true);
    expect(scrubbed?.breadcrumbs?.[2]).toEqual({});
  });

  it("redacts the breadcrumbs an event carries like beforeBreadcrumb does", () => {
    const crumbs: ScrubbableBreadcrumb[] = [
      { type: "http", category: "fetch", data: { url: BOT_URL, method: "POST", status_code: 200 } },
      { type: "http", category: "http", data: { url: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSy-test", "http.query": "key=AIzaSy-test", "http.fragment": "f" } },
    ];
    const scrubbed = scrubEvent({ breadcrumbs: crumbs });
    expect(scrubbed?.breadcrumbs).toEqual([
      { type: "http", category: "fetch", data: { url: "https://api.telegram.org/bot[redacted]/sendMessage", method: "POST", status_code: 200 } },
      { type: "http", category: "http", data: { url: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword" } },
    ]);
    expect(JSON.stringify(scrubbed)).not.toMatch(/123:ABC|AIzaSy-test/);
    expect(crumbs[0]?.data?.url).toBe(BOT_URL);
  });

  it("leaves events without request, user or breadcrumbs untouched", () => {
    const event = { message: "boom", tags: { service: "web" } };
    expect(scrubEvent(event)).toEqual(event);
  });
});

describe("scrubBreadcrumb", () => {
  it("hides the Telegram bot token and the query of outgoing requests", () => {
    const crumb: ScrubbableBreadcrumb = { type: "http", category: "http", data: { url: `${BOT_URL}?chat_id=1`, "http.query": "chat_id=1", method: "POST" } };
    expect(scrubBreadcrumb(crumb)).toEqual({ type: "http", category: "http", data: { url: "https://api.telegram.org/bot[redacted]/sendMessage", method: "POST" } });
    expect(crumb.data?.url).toBe(`${BOT_URL}?chat_id=1`);
  });

  it("cuts navigation URLs and console messages too, and leaves other breadcrumbs alone", () => {
    expect(scrubBreadcrumb({ category: "navigation", data: { from: "/fr/connexion?next=%2Fcompte", to: "/fr/compte#profil" } })).toEqual({
      category: "navigation",
      data: { from: "/fr/connexion", to: "/fr/compte" },
    });
    expect(scrubBreadcrumb({ category: "console", message: "sent to a@b.ma" })).toEqual({ category: "console", message: "sent to [email]" });
    // The console integrations keep the raw arguments next to the joined message.
    expect(scrubBreadcrumb({ category: "console", message: "sent to a@b.ma", data: { arguments: ["sent to a@b.ma", 3], logger: "console" } })).toEqual({
      category: "console",
      message: "sent to [email]",
      data: { arguments: ["sent to [email]", 3], logger: "console" },
    });
    const plain = { category: "ui.click", message: "button" };
    expect(scrubBreadcrumb(plain)).toEqual(plain);
  });
});

describe("redaction helpers", () => {
  it("strips the query and fragment and hides bot tokens", () => {
    expect(redactUrl("https://joutiya.ma/fr/reset?oobCode=x&key=y#frag")).toBe("https://joutiya.ma/fr/reset");
    expect(redactUrl("https://api.telegram.org/bot123:ABC")).toBe("https://api.telegram.org/bot[redacted]");
    expect(redactUrl("/robots.txt")).toBe("/robots.txt");
    expect(redactUrl("")).toBe("");
  });

  it("replaces e-mail addresses and bot tokens in text, nothing else", () => {
    expect(redactText("a.b-c+d@mail.example.ma and x@y.ma")).toBe("[email] and [email]");
    expect(redactText(`GET ${BOT_URL} 401`)).toBe("GET https://api.telegram.org/bot[redacted]/sendMessage 401");
    expect(redactText("redis://:pass@valkey-queue:6379 failed")).toBe("redis://:pass@valkey-queue:6379 failed");
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
