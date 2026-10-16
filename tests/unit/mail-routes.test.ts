import { createHmac, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/mail/suppressions", () => ({ addSuppression: vi.fn(async () => undefined), isSuppressed: vi.fn(async () => false) }));

const { addSuppression } = await import("@/lib/mail/suppressions");
const { resetServerEnv } = await import("@/lib/env");
const { memoryMailbox, MemoryTransport } = await import("@/lib/mail/transports/memory");
const webhook = await import("@/app/api/webhooks/mail/route");
const mailbox = await import("@/app/api/dev/mailbox/route");

const context = { params: Promise.resolve({}) };
const call = (handler: (request: NextRequest, ctx: typeof context) => Promise<Response>, request: Request) => handler(request as NextRequest, context);

const rawKey = randomBytes(24);
const SECRET = `whsec_${rawKey.toString("base64")}`;

function signedRequest(raw: string, overrides: Record<string, string> = {}): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac("sha256", rawKey).update(`msg_1.${timestamp}.${raw}`).digest("base64")}`;
  return new Request("https://joutiya.test/api/webhooks/mail", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": signature, ...overrides },
    body: raw,
  });
}

const bounce = JSON.stringify({ type: "email.bounced", data: { to: ["nadia@example.com"], bounce: { type: "Permanent" } } });

function setEnv(values: Record<string, string>): void {
  for (const key of ["APP_ENV", "DEV_MAILBOX", "MAIL_WEBHOOK_SECRET"]) delete process.env[key];
  Object.assign(process.env, values);
  resetServerEnv();
}

afterEach(() => setEnv({}));

describe("POST /api/webhooks/mail", () => {
  beforeEach(() => {
    setEnv({ MAIL_WEBHOOK_SECRET: SECRET });
    vi.mocked(addSuppression).mockClear();
  });

  it("answers 503 while the webhook secret is unset", async () => {
    setEnv({});
    const response = await call(webhook.POST, signedRequest(bounce));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it("rejects an invalid signature with 401 and touches nothing", async () => {
    const response = await call(webhook.POST, signedRequest(bounce, { "svix-signature": "v1,AAAA" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(addSuppression).not.toHaveBeenCalled();
    const missing = await call(webhook.POST, new Request("https://joutiya.test/api/webhooks/mail", { method: "POST", body: bounce }));
    expect(missing.status).toBe(401);
  });

  it("caps the body at 256 KiB", async () => {
    const declared = await call(webhook.POST, signedRequest(bounce, { "content-length": String(300 * 1024) }));
    expect(declared.status).toBe(413);
    const huge = await call(webhook.POST, signedRequest("x".repeat(256 * 1024 + 1)));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("stores a permanent bounce and answers 200", async () => {
    const response = await call(webhook.POST, signedRequest(bounce));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ received: true });
    expect(addSuppression).toHaveBeenCalledWith("nadia@example.com", "bounce", "resend");
  });

  it("answers 200 to ignored events and when storage fails", async () => {
    const delivered = await call(webhook.POST, signedRequest(JSON.stringify({ type: "email.delivered", data: { to: ["a@example.com"] } })));
    expect(delivered.status).toBe(200);
    expect(addSuppression).not.toHaveBeenCalled();
    vi.mocked(addSuppression).mockRejectedValueOnce(new Error("firestore down"));
    const failing = await call(webhook.POST, signedRequest(bounce));
    expect(failing.status).toBe(200);
  });
});

describe("/api/dev/mailbox", () => {
  beforeEach(async () => {
    setEnv({ APP_ENV: "dev", DEV_MAILBOX: "true" });
    memoryMailbox().clear();
    const transport = new MemoryTransport();
    await transport.send({ from: "f", to: "Nadia@Example.com", subject: "one", text: "t", html: "h", meta: { template: "verifyEmail", locale: "fr", data: { displayName: "N", actionUrl: "u" } } });
    await transport.send({ from: "f", to: "other@example.com", subject: "two", text: "t", html: "h", meta: { template: "resetPassword", locale: "ar", data: { displayName: "O", actionUrl: "u" } } });
  });

  it("is a 404 outside the development mailbox", async () => {
    setEnv({ APP_ENV: "dev" });
    expect((await call(mailbox.GET, new Request("https://joutiya.test/api/dev/mailbox"))).status).toBe(404);
    expect((await call(mailbox.DELETE, new Request("https://joutiya.test/api/dev/mailbox", { method: "DELETE" }))).status).toBe(404);
    expect(memoryMailbox().list()).toHaveLength(2);
  });

  it("lists mails newest first, filtered by recipient (case-insensitive) and template", async () => {
    const all = await call(mailbox.GET, new Request("https://joutiya.test/api/dev/mailbox"));
    expect(all.status).toBe(200);
    expect(all.headers.get("Cache-Control")).toBe("no-store");
    const { mails } = (await all.json()) as { mails: { subject: string; template: string; locale: string; to: string }[] };
    expect(mails.map((mail) => mail.subject)).toEqual(["two", "one"]);
    expect(mails[0]).toMatchObject({ template: "resetPassword", locale: "ar", to: "other@example.com" });

    const mine = await call(mailbox.GET, new Request("https://joutiya.test/api/dev/mailbox?to=nadia%40example.com"));
    expect(((await mine.json()) as { mails: unknown[] }).mails).toHaveLength(1);
    const byTemplate = await call(mailbox.GET, new Request("https://joutiya.test/api/dev/mailbox?template=resetPassword"));
    expect(((await byTemplate.json()) as { mails: { subject: string }[] }).mails.map((mail) => mail.subject)).toEqual(["two"]);
    const none = await call(mailbox.GET, new Request("https://joutiya.test/api/dev/mailbox?to=nobody%40example.com"));
    expect(((await none.json()) as { mails: unknown[] }).mails).toEqual([]);
  });

  it("clears the mailbox on DELETE", async () => {
    const response = await call(mailbox.DELETE, new Request("https://joutiya.test/api/dev/mailbox", { method: "DELETE" }));
    expect(response.status).toBe(204);
    expect(memoryMailbox().list()).toEqual([]);
  });
});
