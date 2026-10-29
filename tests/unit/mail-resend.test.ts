import { describe, expect, it, vi } from "vitest";
import { classifyStatus, isQuotaRefusal, ProviderError, QUOTA_RETRY_AFTER_SECONDS } from "@/lib/mail/transports/errors";
import { RESEND_ENDPOINT, ResendTransport, resendTags } from "@/lib/mail/transports/resend";
import { BREVO_ENDPOINT, BrevoTransport } from "@/lib/mail/transports/brevo";
import type { RenderedMail } from "@/lib/mail/types";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));

const MAIL: RenderedMail = {
  from: "Aalan <no-reply@notif.joutiya.ma>",
  to: "nadia@example.com",
  subject: "Confirme ton adresse e-mail",
  text: "Bonjour",
  html: "<p>Bonjour</p>",
  tags: { template: "verifyEmail", env: "staging" },
  meta: { template: "verifyEmail", locale: "fr", data: { displayName: "Nadia", actionUrl: "https://x" } },
};

type Call = { url: string; init: RequestInit };

function fetchMock(response: Response | (() => Response)) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof response === "function" ? response() : response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("ResendTransport", () => {
  it("posts the documented body with auth, user agent and idempotency key", async () => {
    const { fn, calls } = fetchMock(jsonResponse(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    const result = await new ResendTransport("re_test_key", fn, "joutiya/1.2.3").send(MAIL, "verify-uid-1");
    expect(result).toEqual({ provider: "resend", id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("joutiya/1.2.3");
    expect(headers["Idempotency-Key"]).toBe("verify-uid-1");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call.init.body))).toEqual({
      from: MAIL.from,
      to: [MAIL.to],
      subject: MAIL.subject,
      html: MAIL.html,
      text: MAIL.text,
      tags: [
        { name: "template", value: "verifyEmail" },
        { name: "env", value: "staging" },
      ],
    });
  });

  it("omits the idempotency header and adds reply_to and headers when given", async () => {
    const { fn, calls } = fetchMock(jsonResponse(200, { id: "x" }));
    await new ResendTransport("re_test_key", fn, "ua").send({ ...MAIL, replyTo: "contact@joutiya.ma", headers: { "X-Entity-Ref-ID": "1" }, tags: undefined });
    const [call] = calls as [Call];
    expect((call.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
    const body = JSON.parse(String(call.init.body));
    expect(body.reply_to).toBe("contact@joutiya.ma");
    expect(body.headers).toEqual({ "X-Entity-Ref-ID": "1" });
    expect(body.tags).toBeUndefined();
  });

  it("marks a rate-limit 429 as retryable with Retry-After and 5xx as retryable", async () => {
    const limited = fetchMock(jsonResponse(429, { name: "rate_limit_exceeded", message: "Too many requests. You can only make 2 requests per second.", statusCode: 429 }, { "retry-after": "1" }));
    const error = await new ResendTransport("k", limited.fn, "ua").send(MAIL).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    const provider = error as ProviderError;
    expect(provider.retryable).toBe(true);
    expect(provider.status).toBe(429);
    expect(provider.retryAfterSeconds).toBe(1);
    expect(provider.kind).toBe("transient");
    expect(provider.message).toContain("rate_limit_exceeded");
    // The provider's own message may quote the recipient: it stays in the log (F10).
    expect(provider.message).not.toContain("Too many requests");
    expect(provider.message).not.toContain("k");

    const down = fetchMock(new Response("<html>bad gateway</html>", { status: 502 }));
    const second = (await new ResendTransport("k", down.fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError;
    expect(second.retryable).toBe(true);
    expect(second.status).toBe(502);
  });

  it("marks a spent-quota 429 as 'quota', not retried in place (B3-02: the five quick retries would burn for nothing)", async () => {
    const daily = fetchMock(jsonResponse(429, { name: "daily_quota_exceeded", message: "You have reached your daily email sending quota.", statusCode: 429 }, { "retry-after": "3600" }));
    const error = (await new ResendTransport("k", daily.fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "quota", retryable: false, status: 429, retryAfterSeconds: 3600 });
    expect(error.message).toContain("daily_quota_exceeded");
    expect(error.message).not.toContain("You have reached");

    const monthly = fetchMock(jsonResponse(429, { name: "monthly_quota_exceeded", message: "You have reached your monthly email sending quota.", statusCode: 429 }));
    expect(((await new ResendTransport("k", monthly.fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError).kind).toBe("quota");
    // No name but a long wait: a quota too; a short wait without a name stays a rate limit.
    const anonymous = fetchMock(jsonResponse(429, {}, { "retry-after": String(QUOTA_RETRY_AFTER_SECONDS + 1) }));
    expect(((await new ResendTransport("k", anonymous.fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError).kind).toBe("quota");
    const brief = fetchMock(jsonResponse(429, {}, { "retry-after": String(QUOTA_RETRY_AFTER_SECONDS) }));
    expect(((await new ResendTransport("k", brief.fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError).kind).toBe("transient");

    expect(isQuotaRefusal(429, { name: "daily_quota_exceeded" })).toBe(true);
    expect(isQuotaRefusal(429, { message: "Daily quota reached" })).toBe(true);
    expect(isQuotaRefusal(429, {}, 61)).toBe(true);
    expect(isQuotaRefusal(429, {}, 60)).toBe(false);
    expect(isQuotaRefusal(429, { name: "rate_limit_exceeded" }, 1)).toBe(false);
    // Only a 429 can be a quota refusal: a 403 naming a quota is still "unavailable".
    expect(isQuotaRefusal(403, { name: "quota" }, 3600)).toBe(false);
    expect(classifyStatus(429, { name: "daily_quota_exceeded" })).toBe("quota");
    expect(classifyStatus(403, { name: "daily_quota_exceeded" }, 3600)).toBe("unavailable");
  });

  it("marks 400 and 422 as rejected, 401/402/403/404 as provider unavailable: none retried in place", async () => {
    for (const [status, kind] of [[422, "rejected"], [400, "rejected"], [401, "unavailable"], [402, "unavailable"], [403, "unavailable"], [404, "unavailable"]] as const) {
      const { fn } = fetchMock(jsonResponse(status, { name: "validation_error", message: "Invalid `to` field nadia@example.com", statusCode: status }));
      const error = (await new ResendTransport("k", fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError;
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.kind).toBe(kind);
      expect(error.retryable).toBe(false);
      expect(error.status).toBe(status);
      expect(error.message).toBe(`resend: HTTP ${status} validation_error`);
      expect(classifyStatus(status)).toBe(kind);
    }
    expect(classifyStatus(500)).toBe("transient");
    expect(classifyStatus(429)).toBe("transient");
  });

  it("treats a concurrent idempotent request as retryable, a conflicting one as final", async () => {
    const inFlight = fetchMock(jsonResponse(409, { name: "concurrent_idempotent_requests", statusCode: 409 }));
    expect(((await new ResendTransport("k", inFlight.fn, "ua").send(MAIL, "a").catch((e: unknown) => e)) as ProviderError).retryable).toBe(true);
    const conflict = fetchMock(jsonResponse(409, { name: "invalid_idempotent_request", statusCode: 409 }));
    expect(((await new ResendTransport("k", conflict.fn, "ua").send(MAIL, "a").catch((e: unknown) => e)) as ProviderError).retryable).toBe(false);
  });

  it("wraps network failures as retryable", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = (await new ResendTransport("k", fn, "ua").send(MAIL).catch((caught: unknown) => caught)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
  });

  it("reads the quota headers tolerantly", async () => {
    const plain = fetchMock(jsonResponse(200, { id: "a" }, { "x-resend-daily-quota": "42", "x-resend-monthly-quota": "1200" }));
    expect((await new ResendTransport("k", plain.fn, "ua").send(MAIL)).quota).toEqual({ daily: 42, monthly: 1200 });
    const odd = fetchMock(jsonResponse(200, { id: "a" }, { "x-resend-daily-quota": "7/100", "x-resend-monthly-quota": "n/a" }));
    expect((await new ResendTransport("k", odd.fn, "ua").send(MAIL)).quota).toEqual({ daily: 7 });
    const none = fetchMock(jsonResponse(200, { id: "a" }));
    expect((await new ResendTransport("k", none.fn, "ua").send(MAIL)).quota).toBeUndefined();
    const broken = fetchMock(new Response("not json", { status: 200 }));
    expect(await new ResendTransport("k", broken.fn, "ua").send(MAIL)).toEqual({ provider: "resend", id: "" });
  });

  it("cleans tags to Resend's alphabet", () => {
    expect(resendTags({ template: "verify Email", env: "prod" })).toEqual([
      { name: "template", value: "verify_Email" },
      { name: "env", value: "prod" },
    ]);
    expect(resendTags(undefined)).toBeUndefined();
    expect(resendTags({ empty: "" })).toBeUndefined();
  });
});

describe("BrevoTransport", () => {
  it("posts the Brevo body with the api-key header", async () => {
    const { fn, calls } = fetchMock(jsonResponse(201, { messageId: "<202610161030.1@relay.brevo.com>" }));
    const result = await new BrevoTransport("xkeysib-test", fn, "joutiya/1.2.3").send(MAIL);
    expect(result).toEqual({ provider: "brevo", id: "<202610161030.1@relay.brevo.com>" });
    const [call] = calls as [Call];
    expect(call.url).toBe(BREVO_ENDPOINT);
    const headers = call.init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("xkeysib-test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("joutiya/1.2.3");
    const body = JSON.parse(String(call.init.body));
    expect(body.sender).toEqual({ name: "Aalan", email: "no-reply@notif.joutiya.ma" });
    expect(body.to).toEqual([{ email: MAIL.to }]);
    expect(body.subject).toBe(MAIL.subject);
    expect(body.htmlContent).toBe(MAIL.html);
    expect(body.textContent).toBe(MAIL.text);
    expect(body.tags).toEqual(["template:verifyEmail", "env:staging"]);
  });

  it("classifies Brevo errors", async () => {
    const limited = fetchMock(jsonResponse(429, { code: "too_many_requests", message: "Rate limit" }, { "x-sib-ratelimit-reset": "12" }));
    const error = (await new BrevoTransport("k", limited.fn, "ua").send(MAIL).catch((e: unknown) => e)) as ProviderError;
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.message).toContain("too_many_requests");
    expect(error.message).not.toContain("Rate limit");
    const bad = fetchMock(jsonResponse(400, { code: "invalid_parameter", message: "sender" }));
    expect((await new BrevoTransport("k", bad.fn, "ua").send(MAIL).catch((e: unknown) => e)) as ProviderError).toMatchObject({ kind: "rejected", retryable: false });
    const revoked = fetchMock(jsonResponse(401, { code: "unauthorized", message: "Key not found" }));
    expect((await new BrevoTransport("k", revoked.fn, "ua").send(MAIL).catch((e: unknown) => e)) as ProviderError).toMatchObject({ kind: "unavailable", retryable: false, message: "brevo: HTTP 401 unauthorized" });
  });
});
