import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// WhatsApp verification flow against the Auth and Firestore emulators: start -> status ->
// signed webhook -> verified, plus the refusals (CSRF, signature, replay, limits, duplicates).

const ENV = vi.hoisted(() => {
  const values = {
    WHATSAPP_APP_SECRET: "api-test-app-secret",
    WHATSAPP_VERIFY_TOKEN: "api-test-verify-token",
    WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
    WHATSAPP_DISPLAY_NUMBER: "212600000000",
  };
  Object.assign(process.env, values);
  return values;
});

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as start } from "@/app/api/auth/phone/start/route";
import { GET as status } from "@/app/api/auth/phone/status/route";
import { GET as handshake, POST as webhook } from "@/app/api/webhooks/whatsapp/route";
import { COLLECTIONS } from "@/lib/db/schemas";
import { createAccountDocuments, getUser, getUserPrivate } from "@/lib/db/repositories/users";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { displayPhone } from "@/lib/phone/normalize";
import { resetPhoneVerifierForTests } from "@/lib/phone-verify";
import { resetChallengeStoreForTests } from "@/lib/phone-verify/store";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";

const ORIGIN = "http://localhost:3000";
const ctx = { params: Promise.resolve({}) };
const sendMailMock = vi.mocked(sendMail);

interface Member {
  uid: string;
  email: string;
  cookie: string;
  csrf: string;
}

let counter = 0;
const run = Date.now().toString(36);

async function member(): Promise<Member> {
  counter += 1;
  const uid = `phone-${run}-${counter}`;
  const email = `${uid}@example.com`;
  await auth().createUser({ uid, email, emailVerified: true, password: ["Str0ng", "Passw0rd!"].join("-") });
  await createAccountDocuments({
    uid,
    email,
    displayName: "Testeur Joutiya",
    locale: "fr",
    consents: { cguVersion: "2026-10", transfersVersion: "2026-10", marketing: false },
    provider: "password",
    activated: true,
  });
  await setClaims(uid, { role: "individual" });
  const { cookie } = await createSessionForUid(uid);
  return { uid, email, cookie, csrf: csrfToken(cookie) };
}

/** A fresh valid Moroccan mobile for each use (numbers verified in Firestore persist across tests). */
const numberSeed = Date.now() % 10_000_000;
let numberCounter = 0;
function freshNumber(): { typed: string; e164: string; from: string; national: string } {
  numberCounter += 1;
  const digits = `61${String((numberSeed + numberCounter) % 10_000_000).padStart(7, "0")}`;
  return { typed: `0${digits}`, e164: `+212${digits}`, from: `212${digits}`, national: displayPhone(`+212${digits}`) };
}

function memberHeaders(m: Member): Record<string, string> {
  return { host: "localhost:3000", origin: ORIGIN, cookie: `__Host-session=${m.cookie}; __Host-csrf=${m.csrf}`, "x-csrf-token": m.csrf };
}

function postStart(m: Member, phone: unknown, headers: Record<string, string | null> = {}): Promise<Response> {
  const merged: Record<string, string> = { ...memberHeaders(m), "content-type": "application/json" };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  return start(new NextRequest(`${ORIGIN}/api/auth/phone/start`, { method: "POST", headers: merged, body: JSON.stringify({ phone }) }), ctx);
}

function getStatus(m: Member | null): Promise<Response> {
  const headers: Record<string, string> = { host: "localhost:3000" };
  if (m) headers["cookie"] = `__Host-session=${m.cookie}`;
  return status(new NextRequest(`${ORIGIN}/api/auth/phone/status`, { headers }), ctx);
}

const sign = (raw: string, secret = ENV.WHATSAPP_APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function inbound(from: string, body: string, wamid: string, phoneNumberId = ENV.WHATSAPP_PHONE_NUMBER_ID): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: ENV.WHATSAPP_DISPLAY_NUMBER, phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Testeur" }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: "1760000000", type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

function postWebhook(payload: unknown, signature?: string | null): Promise<Response> {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-hub-signature-256"] = signature ?? sign(raw);
  return webhook(new NextRequest(`${ORIGIN}/api/webhooks/whatsapp`, { method: "POST", headers, body: raw }), ctx);
}

async function startPending(m: Member, typed: string): Promise<{ code: string; waLink: string }> {
  const response = await postStart(m, typed);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string; code: string; waLink: string };
  expect(body.status).toBe("pending");
  return body;
}

let wamidCounter = 0;
const wamid = () => `wamid.${run}.${++wamidCounter}`;

beforeAll(() => {
  resetServerEnv();
});

beforeEach(() => {
  resetRateLimiters();
  resetChallengeStoreForTests();
  resetPhoneVerifierForTests();
  sendMailMock.mockClear();
});

describe("POST /api/auth/phone/start", () => {
  it("starts a challenge: code, wa.me link and expiry", async () => {
    const m = await member();
    const { typed } = freshNumber();
    const before = Date.now();
    const response = await postStart(m, typed);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { status: string; code: string; waLink: string; number: string; expiresAt: string };
    expect(body.status).toBe("pending");
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.number).toBe(ENV.WHATSAPP_DISPLAY_NUMBER);
    expect(body.waLink).toBe(`https://wa.me/${ENV.WHATSAPP_DISPLAY_NUMBER}?text=${encodeURIComponent(`JOUTIYA ${body.code}`)}`);
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThan(before + 9 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  it("refuses the request without the CSRF header, without Origin or without a session", async () => {
    const m = await member();
    const { typed } = freshNumber();
    const noCsrf = await postStart(m, typed, { "x-csrf-token": null });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: { code: string } }).error.code).toBe("csrf");
    const noOrigin = await postStart(m, typed, { origin: null });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe("origin");
    const anonymous = await postStart(m, typed, { cookie: null });
    expect(anonymous.status).toBe(401);
  });

  it("validates the number: landline, invalid, foreign, malformed body", async () => {
    const m = await member();
    const codes: string[] = [];
    for (const phone of ["0512345678", "123456789", "+33612345678", 12345]) {
      const response = await postStart(m, phone);
      expect(response.status).toBe(400);
      codes.push(((await response.json()) as { error: { code: string } }).error.code);
    }
    expect(codes).toEqual(["phone_not_mobile", "phone_invalid", "phone_invalid", "invalid_body"]);
    // Nothing consumed the account quota.
    expect((await postStart(m, freshNumber().typed)).status).toBe(200);
  });

  it("limits a number to one start per minute per account, without locking other accounts out", async () => {
    const alice = await member();
    const bob = await member();
    const { typed } = freshNumber();
    expect((await postStart(alice, typed)).status).toBe(200);
    const response = await postStart(alice, typed);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // A stranger's start on the owner's number never blocks the owner.
    expect((await postStart(bob, typed)).status).toBe(200);
  });

  it("limits an account to 3 starts per day", async () => {
    const m = await member();
    for (let i = 0; i < 3; i += 1) expect((await postStart(m, freshNumber().typed)).status).toBe(200);
    expect((await postStart(m, freshNumber().typed)).status).toBe(429);
  });

  it("replaces the pending challenge of the account", async () => {
    const m = await member();
    const first = freshNumber();
    const second = freshNumber();
    await startPending(m, first.typed);
    const challenge = await startPending(m, second.typed);
    const pending = (await (await getStatus(m)).json()) as { status: string; phone: string };
    expect(pending).toEqual({ status: "pending", phone: second.national });
    // The old number no longer verifies anything.
    expect((await postWebhook(inbound(first.from, `JOUTIYA ${challenge.code}`, wamid()))).status).toBe(200);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("pending");
  });
});

describe("GET /api/auth/phone/status", () => {
  it("answers none for an account without challenge, 401 without session", async () => {
    const m = await member();
    const response = await getStatus(m);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "none", phone: null });
    expect((await getStatus(null)).status).toBe(401);
  });

  it("answers pending with the national form of the number, whatever the typed form", async () => {
    const m = await member();
    const number = freshNumber();
    // Typed in international form with spaces: "+212 6X XX XX XX XX".
    await startPending(m, `+212 ${number.national.slice(1)}`);
    const body = (await (await getStatus(m)).json()) as { status: string; phone: string };
    expect(body).toEqual({ status: "pending", phone: number.national });
    expect(body.phone).toMatch(/^06 \d{2} \d{2} \d{2} \d{2}$/);
  });
});

describe("GET /api/webhooks/whatsapp (handshake)", () => {
  const url = (token: string, challenge = "1158201444") => `${ORIGIN}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`;

  it("echoes the challenge for the configured verify token", async () => {
    const response = await handshake(new NextRequest(url(ENV.WHATSAPP_VERIFY_TOKEN)), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("1158201444");
  });

  it("refuses a wrong token, a wrong mode or a missing challenge", async () => {
    expect((await handshake(new NextRequest(url("wrong-token")), ctx)).status).toBe(403);
    expect((await handshake(new NextRequest(url(ENV.WHATSAPP_VERIFY_TOKEN).replace("subscribe", "unsubscribe")), ctx)).status).toBe(403);
    expect((await handshake(new NextRequest(`${ORIGIN}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${ENV.WHATSAPP_VERIFY_TOKEN}`), ctx)).status).toBe(403);
    expect((await handshake(new NextRequest(`${ORIGIN}/api/webhooks/whatsapp`), ctx)).status).toBe(403);
  });
});

describe("POST /api/webhooks/whatsapp", () => {
  it("verifies the account when the sender number and the code match the challenge", async () => {
    const m = await member();
    const number = freshNumber();
    const challenge = await startPending(m, number.typed);
    const response = await postWebhook(inbound(number.from, `JOUTIYA ${challenge.code}`, wamid()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    const state = (await (await getStatus(m)).json()) as { status: string; phone: string };
    expect(state).toEqual({ status: "verified", phone: number.national });

    const account = await getUserPrivate(m.uid);
    expect(account?.phoneE164).toBe(number.e164);
    expect(account?.phoneVerifiedAt).toBeTruthy();
    expect((await getUser(m.uid))?.badges.phoneVerified).toBe(true);

    const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", m.uid).get();
    expect(audits.docs.map((doc) => doc.get("action"))).toContain("phone.verified");

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0]?.[0]).toMatchObject({ template: "phoneVerified", locale: "fr", to: m.email, data: { displayName: "Testeur Joutiya", phone: state.phone } });
  });

  it("accepts the bare code as message text", async () => {
    const m = await member();
    const number = freshNumber();
    const challenge = await startPending(m, number.typed);
    expect((await postWebhook(inbound(number.from, challenge.code, wamid()))).status).toBe(200);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("verified");
  });

  it("leaves the challenge pending on a wrong code, another sender or a message without code", async () => {
    const m = await member();
    const number = freshNumber();
    const other = freshNumber();
    const challenge = await startPending(m, number.typed);
    const wrong = String((Number(challenge.code) + 1) % 1_000_000).padStart(6, "0");
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${wrong}`, wamid()))).status).toBe(200);
    expect((await postWebhook(inbound(other.from, `JOUTIYA ${challenge.code}`, wamid()))).status).toBe(200);
    expect((await postWebhook(inbound(number.from, "Salam, c'est bien ici ?", wamid()))).status).toBe(200);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("pending");
    expect(sendMailMock).not.toHaveBeenCalled();
    // The right code still works afterwards.
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${challenge.code}`, wamid()))).status).toBe(200);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("verified");
  });

  it("ignores a replayed wamid", async () => {
    const m = await member();
    const number = freshNumber();
    const challenge = await startPending(m, number.typed);
    const id = wamid();
    const wrong = String((Number(challenge.code) + 1) % 1_000_000).padStart(6, "0");
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${wrong}`, id))).status).toBe(200);
    // Same message id, now with the right code: already processed, so nothing happens.
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${challenge.code}`, id))).status).toBe(200);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("pending");
  });

  it("ignores statuses, other phone number ids and a verified replay of the same account", async () => {
    const m = await member();
    const number = freshNumber();
    const challenge = await startPending(m, number.typed);
    const statuses = { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: ENV.WHATSAPP_PHONE_NUMBER_ID }, statuses: [{ id: wamid(), status: "read" }] } }] }] };
    expect((await postWebhook(statuses)).status).toBe(200);
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${challenge.code}`, wamid(), "999"))).status).toBe(200);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("pending");
  });

  it("refuses a bad or missing signature and malformed input before any processing", async () => {
    const m = await member();
    const number = freshNumber();
    const challenge = await startPending(m, number.typed);
    const payload = inbound(number.from, `JOUTIYA ${challenge.code}`, wamid());
    const bad = await postWebhook(payload, sign(JSON.stringify(payload), "wrong-secret"));
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect((await postWebhook(payload, null)).status).toBe(403);
    expect((await postWebhook(payload, "sha256=zz")).status).toBe(403);
    expect((await postWebhook("{not json")).status).toBe(400);
    // A Meta batch can reach 3 MB; up to 1 MiB is read and checked, beyond that it is refused unread.
    const large = `{"pad":"${"x".repeat(512 * 1024)}"}`;
    expect((await postWebhook(large)).status).toBe(200);
    const big = `{"pad":"${"x".repeat(1024 * 1024)}"}`;
    expect((await postWebhook(big)).status).toBe(413);
    expect(((await (await getStatus(m)).json()) as { status: string }).status).toBe("pending");
  });
});

async function auditActions(uid: string): Promise<string[]> {
  const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", uid).get();
  return audits.docs.map((doc) => doc.get("action") as string);
}

describe("one verified number per account, one account per number", () => {
  it("refuses a new start for an already verified account", async () => {
    const alice = await member();
    const number = freshNumber();
    const challenge = await startPending(alice, number.typed);
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${challenge.code}`, wamid()))).status).toBe(200);
    resetRateLimiters();
    const again = await postStart(alice, freshNumber().typed);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });

  it("moves a number verified elsewhere to the account that proves possession, and tells the previous holder", async () => {
    const alice = await member();
    const number = freshNumber();
    const forAlice = await startPending(alice, number.typed);
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${forAlice.code}`, wamid()))).status).toBe(200);
    expect(((await (await getStatus(alice)).json()) as { status: string }).status).toBe("verified");
    sendMailMock.mockClear();

    // A number verified by another account is not refused (that would reveal it is registered).
    const bob = await member();
    const forBob = await startPending(bob, number.typed);
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${forBob.code}`, wamid()))).status).toBe(200);
    expect((await (await getStatus(bob)).json()) as unknown).toEqual({ status: "verified", phone: number.national });
    expect((await (await getStatus(alice)).json()) as unknown).toEqual({ status: "none", phone: null });

    const bobAccount = await getUserPrivate(bob.uid);
    expect(bobAccount?.phoneE164).toBe(number.e164);
    expect((await getUser(bob.uid))?.badges.phoneVerified).toBe(true);
    const aliceAccount = await getUserPrivate(alice.uid);
    expect(aliceAccount?.phoneE164).toBeUndefined();
    expect(aliceAccount?.phoneVerifiedAt).toBeUndefined();
    expect((await getUser(alice.uid))?.badges.phoneVerified).toBe(false);

    expect(await auditActions(bob.uid)).toContain("phone.verified");
    expect(await auditActions(alice.uid)).toContain("phone.transferred");

    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ template: "phoneRemoved", locale: "fr", to: alice.email, priority: "security", data: { displayName: "Testeur Joutiya", phone: number.national } }));
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ template: "phoneVerified", to: bob.email }));

    // Alice can verify a new number (or take this one back) afterwards.
    resetRateLimiters();
    expect((await postStart(alice, freshNumber().typed)).status).toBe(200);
  });

  it("lets the code pick the account when two accounts hold a challenge for the same number", async () => {
    const alice = await member();
    const bob = await member();
    const number = freshNumber();
    const forAlice = await startPending(alice, number.typed);
    const forBob = await startPending(bob, number.typed);
    // Bob started last, but Alice's code arrives: Alice is verified, Bob stays pending.
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${forAlice.code}`, wamid()))).status).toBe(200);
    expect(((await (await getStatus(alice)).json()) as { status: string }).status).toBe("verified");
    expect(((await (await getStatus(bob)).json()) as { status: string }).status).toBe("pending");
    expect(await auditActions(alice.uid)).not.toContain("phone.transferred");
    // Bob's code then proves possession too: the number moves to Bob.
    expect((await postWebhook(inbound(number.from, `JOUTIYA ${forBob.code}`, wamid()))).status).toBe(200);
    expect(((await (await getStatus(bob)).json()) as { status: string }).status).toBe("verified");
    expect(((await (await getStatus(alice)).json()) as { status: string }).status).toBe("none");
    expect(await auditActions(alice.uid)).toContain("phone.transferred");
  });
});
