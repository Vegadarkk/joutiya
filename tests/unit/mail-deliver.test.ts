import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as quota from "@/lib/quota";
import type { TemplateMail } from "@/lib/mail/types";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/mail/suppressions", () => ({ isSuppressed: vi.fn(async () => false), addSuppression: vi.fn() }));
vi.mock("@/lib/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof quota>()),
  consume: vi.fn(async () => ({ level: "ok" })),
  isDegraded: vi.fn(async () => false),
  isExhausted: vi.fn(async () => false),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => false, valkey: () => ({}), clientOptions: () => ({}) }));
vi.mock("@/lib/legal/config", () => ({ getLegalConfig: vi.fn(async () => ({ companyName: "Adark Prime", hqAddress: "6 rue d'Armaillé, 75017 Paris" })) }));

const { isSuppressed } = await import("@/lib/mail/suppressions");
const { consume, isDegraded, isExhausted } = await import("@/lib/quota");
const { alert } = await import("@/lib/alert");
const { resetServerEnv } = await import("@/lib/env");
const { deliverMail, MailDeferredError, PROVIDER_UNAVAILABLE_RETRY_MS, resetMailAlertMarkers } = await import("@/lib/mail/deliver");
const { memoryMailbox } = await import("@/lib/mail/transports/memory");

const MAIL: TemplateMail<"verifyEmail"> = {
  template: "verifyEmail",
  locale: "fr",
  to: "Nadia@Example.com",
  data: { displayName: "Nadia", actionUrl: "https://joutiya.test/fr/action?mode=verifyEmail&oobCode=1" },
  priority: "transactional",
  idempotencyKey: "verify-uid-1",
};
const SECURITY: TemplateMail = { ...MAIL, priority: "security" };

const ENV_KEYS = ["APP_ENV", "DEV_MAILBOX", "MAIL_API_KEY", "MAIL_FALLBACK_API_KEY", "SITE_URL", "QUEUE_REDIS_URL"] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { SITE_URL: "https://joutiya.test", ...values });
  resetServerEnv();
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function stubFetch(...responses: (Response | (() => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** Quota counters as the test wants them: degraded (≥ 90 %) and exhausted (100 %) per id. */
function quotas(state: Partial<Record<string, "degraded" | "exhausted">>): void {
  vi.mocked(isDegraded).mockImplementation(async (id) => state[id] !== undefined);
  vi.mocked(isExhausted).mockImplementation(async (id) => state[id] === "exhausted");
}

const NOW = new Date("2026-10-16T10:00:00Z");
const RESET_MARGIN_MS = 60_000;

function expectRetryAt(error: unknown, reset: string): void {
  expect(error).toBeInstanceOf(MailDeferredError);
  const retryAt = (error as InstanceType<typeof MailDeferredError>).retryAt.getTime();
  const expected = Date.parse(reset) + RESET_MARGIN_MS;
  // nextPeriodStart bisects to the second: at or up to 1 s after the boundary.
  expect(retryAt).toBeGreaterThanOrEqual(expected);
  expect(retryAt).toBeLessThanOrEqual(expected + 1_000);
}

beforeEach(() => {
  memoryMailbox().clear();
  resetMailAlertMarkers();
  vi.mocked(isSuppressed).mockResolvedValue(false);
  quotas({});
  vi.mocked(consume).mockClear();
  vi.mocked(alert).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setEnv({});
});

describe("deliverMail in development", () => {
  it("keeps mails in memory with DEV_MAILBOX, newest first, filterable by recipient", async () => {
    setEnv({ APP_ENV: "dev", DEV_MAILBOX: "true", MAIL_API_KEY: "re_dev" });
    const calls = stubFetch();
    const first = await deliverMail(MAIL);
    const second = await deliverMail({ ...MAIL, to: "other@example.com", template: "resetPassword", data: { displayName: "O", actionUrl: "https://joutiya.test/r" } });
    expect(first).toMatchObject({ provider: "memory" });
    expect(second).toMatchObject({ provider: "memory" });
    expect(calls).toHaveLength(0);
    const all = memoryMailbox().list();
    expect(all.map((record) => record.template)).toEqual(["resetPassword", "verifyEmail"]);
    const mine = memoryMailbox().list({ to: "nadia@example.com" });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ template: "verifyEmail", locale: "fr", to: "Nadia@Example.com", data: MAIL.data });
    expect(mine[0]?.text).toContain(MAIL.data.actionUrl);
    expect(mine[0]?.text).toContain("Adark Prime · 6 rue d'Armaillé, 75017 Paris");
    expect(mine[0]?.html).toContain(MAIL.data.actionUrl.replace("&", "&amp;"));
    expect(mine[0]?.subject.length).toBeGreaterThan(0);
    expect(typeof mine[0]?.id).toBe("string");
    expect(Number.isNaN(Date.parse(mine[0]?.at ?? ""))).toBe(false);
    expect(memoryMailbox().list({ template: "resetPassword" })).toHaveLength(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it("falls back to memory without any provider key", async () => {
    setEnv({ APP_ENV: "dev" });
    const calls = stubFetch();
    expect(await deliverMail(MAIL)).toMatchObject({ provider: "memory" });
    expect(calls).toHaveLength(0);
    expect(memoryMailbox().list()).toHaveLength(1);
  });

  it("skips suppressed transactional mails but not security mails", async () => {
    setEnv({ APP_ENV: "dev", DEV_MAILBOX: "true" });
    vi.mocked(isSuppressed).mockResolvedValue(true);
    expect(await deliverMail(MAIL)).toEqual({ skipped: "suppressed" });
    expect(await deliverMail({ ...MAIL, priority: undefined })).toEqual({ skipped: "suppressed" });
    expect(memoryMailbox().list()).toHaveLength(0);
    expect(await deliverMail(SECURITY)).toMatchObject({ provider: "memory" });
    expect(memoryMailbox().list()).toHaveLength(1);
  });
});

describe("deliverMail through Resend", () => {
  beforeEach(() => setEnv({ APP_ENV: "dev", MAIL_API_KEY: "re_test", MAIL_FALLBACK_API_KEY: "xkeysib-test" }));

  it("sends through Resend with the idempotency key and counts both quotas", async () => {
    const calls = stubFetch(json(200, { id: "resend-1" }, { "x-resend-daily-quota": "12" }));
    expect(await deliverMail(MAIL)).toEqual({ provider: "resend", id: "resend-1", quota: { daily: 12 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect((calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("verify-uid-1");
    expect(consume).toHaveBeenCalledWith("resend.daily");
    expect(consume).toHaveBeenCalledWith("resend.monthly");
    expect(memoryMailbox().list()).toHaveLength(0);
  });

  it("falls back to Brevo on a 500 for security mails and alerts once a day", async () => {
    const calls = stubFetch(json(500, { name: "application_error" }), json(201, { messageId: "brevo-1" }), json(503, {}), json(201, { messageId: "brevo-2" }));
    expect(await deliverMail(SECURITY)).toEqual({ provider: "brevo", id: "brevo-1" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.resend.com/emails", "https://api.brevo.com/v3/smtp/email"]);
    expect((calls[1]?.init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-test");
    expect(consume).toHaveBeenCalledWith("brevo.daily");
    expect(consume).not.toHaveBeenCalledWith("resend.daily");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Mail: bascule sur Brevo" }));
    // Second fallback the same day: no second alert.
    expect(await deliverMail(SECURITY)).toEqual({ provider: "brevo", id: "brevo-2" });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("rethrows retryable failures of transactional mails so the queue retries", async () => {
    stubFetch(json(429, { name: "rate_limit_exceeded" }, { "retry-after": "1" }));
    await expect(deliverMail(MAIL)).rejects.toMatchObject({ name: "ProviderError", retryable: true, status: 429 });
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps the quick retries for a transient Resend failure when Brevo is exhausted", async () => {
    quotas({ "brevo.daily": "exhausted" });
    stubFetch(json(503, {}));
    await expect(deliverMail(SECURITY)).rejects.toMatchObject({ name: "ProviderError", retryable: true, status: 503 });
  });

  it("drops a mail the provider rejects for good", async () => {
    stubFetch(json(422, { name: "validation_error", message: "Invalid `to` field" }));
    expect(await deliverMail(SECURITY)).toEqual({ skipped: "rejected" });
    expect(consume).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("skips other mails at 90 % and keeps the last 10 % of Resend for security mails", async () => {
    quotas({ "resend.daily": "degraded" });
    const calls = stubFetch(json(200, { id: "resend-s" }));
    expect(await deliverMail(MAIL)).toEqual({ skipped: "quota" });
    expect(calls).toHaveLength(0);
    expect(await deliverMail(SECURITY)).toEqual({ provider: "resend", id: "resend-s" });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(consume).toHaveBeenCalledWith("resend.daily");
  });

  it("routes security mails to Brevo once Resend is exhausted", async () => {
    quotas({ "resend.monthly": "exhausted" });
    const calls = stubFetch(json(201, { messageId: "brevo-q" }));
    expect(await deliverMail(SECURITY)).toEqual({ provider: "brevo", id: "brevo-q" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.brevo.com/v3/smtp/email"]);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Mail: bascule sur Brevo" }));
  });

  it("defers security mails to the earliest reset when Brevo is exhausted too", async () => {
    vi.useFakeTimers({ now: NOW });
    quotas({ "resend.daily": "exhausted", "resend.monthly": "exhausted", "brevo.daily": "exhausted" });
    const calls = stubFetch();
    // Resend is back next month, Brevo tomorrow: the job waits for Brevo.
    expectRetryAt(await deliverMail(SECURITY).catch((error: unknown) => error), "2026-10-17T00:00:00Z");
    expect(calls).toHaveLength(0);
    expect(consume).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("defers security mails to the Resend reset without a fallback key", async () => {
    setEnv({ APP_ENV: "dev", MAIL_API_KEY: "re_test" });
    vi.useFakeTimers({ now: NOW });
    quotas({ "resend.daily": "exhausted" });
    expectRetryAt(await deliverMail(SECURITY).catch((error: unknown) => error), "2026-10-17T00:00:00Z");
    quotas({ "resend.daily": "exhausted", "resend.monthly": "exhausted" });
    expectRetryAt(await deliverMail(SECURITY).catch((error: unknown) => error), "2026-11-01T00:00:00Z");
  });

  it("rethrows a retryable failure of a security mail without a fallback key", async () => {
    setEnv({ APP_ENV: "dev", MAIL_API_KEY: "re_test" });
    stubFetch(json(503, {}));
    await expect(deliverMail(SECURITY)).rejects.toMatchObject({ retryable: true, status: 503 });
  });

  it("treats a 401 as Resend unavailable: P1 alert once a day, Brevo for security mails", async () => {
    const calls = stubFetch(json(401, { name: "restricted_api_key", message: "This API key is restricted" }), json(201, { messageId: "brevo-u" }), json(403, {}), json(201, { messageId: "brevo-u2" }));
    expect(await deliverMail(SECURITY)).toEqual({ provider: "brevo", id: "brevo-u" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.resend.com/emails", "https://api.brevo.com/v3/smtp/email"]);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: "Mail: resend indisponible (HTTP 401)" }));
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Mail: bascule sur Brevo" }));
    const body = vi.mocked(alert).mock.calls.find(([event]) => event.severity === "P1")?.[0].body ?? "";
    expect(body).not.toContain("This API key is restricted");
    expect(alert).toHaveBeenCalledTimes(2);
    // The same day: no second P1, still Brevo.
    expect(await deliverMail(SECURITY)).toEqual({ provider: "brevo", id: "brevo-u2" });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(consume).not.toHaveBeenCalledWith("resend.daily");
  });

  it("waits an hour (not five quick retries) when Resend is unavailable and nothing can take over", async () => {
    vi.useFakeTimers({ now: NOW });
    stubFetch(json(403, { name: "validation_error", message: "domain not verified" }), json(403, {}));
    // Transactional mails never use Brevo.
    const first = await deliverMail(MAIL).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(MailDeferredError);
    expect((first as InstanceType<typeof MailDeferredError>).retryAt.getTime()).toBe(NOW.getTime() + PROVIDER_UNAVAILABLE_RETRY_MS);
    expect((first as Error).message).not.toContain("domain not verified");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: "Mail: resend indisponible (HTTP 403)" }));
    // A security mail without a fallback key waits too.
    setEnv({ APP_ENV: "dev", MAIL_API_KEY: "re_test" });
    const second = await deliverMail(SECURITY).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(MailDeferredError);
    expect(consume).not.toHaveBeenCalled();
  });
});
