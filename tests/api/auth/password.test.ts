import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNIFORM_RESPONSE_MS } from "@/lib/auth/anonymous";
import { auth } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { verifySession } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import type * as Turnstile from "@/lib/security/turnstile";
import { POST as action } from "@/app/api/auth/action/route";
import { GET as inbox } from "@/app/api/conversations/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as passwordChange } from "@/app/api/auth/password/change/route";
import { POST as resetConfirm } from "@/app/api/auth/password/confirm/route";
import { POST as resetRequest } from "@/app/api/auth/password/reset/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { CONSENTS, Jar, PASSWORD, call, capturedMails, lastMail, oobCodeOf, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

// Assembled at runtime: a literal would look like a credential to the secret scan.
const NEW_PASSWORD = ["Fresh", "Argan", "Oil", "42"].join("-");

async function verifiedAccount(displayName = "Reset Tester") {
  const jar = new Jar();
  const email = uniqueEmail("p");
  expect((await call(signup, "/api/auth/signup", { jar, body: { email, password: PASSWORD, displayName, locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
  const verified = await call<SignedInBody>(action, "/api/auth/action", { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(lastMail(sendMail, "verifyEmail", email)!.data.actionUrl) } });
  expect(verified.status).toBe(200);
  return { jar, email, uid: verified.body.session.uid };
}

/** Revocation has a one-second granularity (auth_time vs tokensValidAfterTime): sessions minted in the same second survive. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

async function sessionAlive(jar: Jar): Promise<boolean> {
  const cookie = jar.get("__Host-session");
  return (await verifySession(cookie, { checkRevoked: true })) !== null;
}

beforeEach(() => resetRateLimiters());

describe("password reset", () => {
  it("mails a reset link, checks the code, sets the password and revokes the old sessions", async () => {
    const { jar, email, uid } = await verifiedAccount();
    expect(await sessionAlive(jar)).toBe(true);

    const requested = await call<{ status: string }>(resetRequest, "/api/auth/password/reset", { jar: new Jar(), body: { email, turnstileToken: "t" } });
    expect(requested.status).toBe(202);
    expect(requested.body).toEqual({ status: "sent" });
    const mail = lastMail(sendMail, "resetPassword", email)!;
    expect(mail.priority).toBe("security");
    expect(mail.data.displayName).toBe("Reset Tester");
    expect(mail.data.actionUrl).toMatch(/^http:\/\/localhost:3000\/fr\/action\?mode=resetPassword&oobCode=/);
    const oobCode = oobCodeOf(mail.data.actionUrl);

    const checked = await call<{ status: string; email: string }>(action, "/api/auth/action", { jar: new Jar(), body: { mode: "resetPassword", oobCode } });
    expect(checked.status).toBe(200);
    expect(checked.body).toEqual({ status: "reset_ok", email });
    // A reset code is not a verification code.
    const misuse = await call<ErrorBody>(action, "/api/auth/action", { jar: new Jar(), body: { mode: "verifyEmail", oobCode } });
    expect(misuse.status).toBe(400);
    expect(misuse.body.error.code).toBe("invalid_code");

    const weak = await call<ErrorBody>(resetConfirm, "/api/auth/password/confirm", { jar: new Jar(), body: { oobCode, password: "password123" } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("weak_password");
    const personal = await call<ErrorBody>(resetConfirm, "/api/auth/password/confirm", { jar: new Jar(), body: { oobCode, password: `${email.split("@")[0]}-x` } });
    expect(personal.body.error.code).toBe("weak_password");

    await nextSecond();
    const confirmed = await call<{ status: string }>(resetConfirm, "/api/auth/password/confirm", { jar: new Jar(), body: { oobCode, password: NEW_PASSWORD } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ status: "password_reset" });
    expect(lastMail(sendMail, "passwordChanged", email)?.data.displayName).toBe("Reset Tester");
    expect(await sessionAlive(jar)).toBe(false);

    const reused = await call<ErrorBody>(resetConfirm, "/api/auth/password/confirm", { jar: new Jar(), body: { oobCode, password: NEW_PASSWORD } });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe("invalid_code");

    const old = await call<ErrorBody>(login, "/api/auth/login", { jar: new Jar(), body: { email, password: PASSWORD } });
    expect(old.status).toBe(401);
    const fresh = await call<SignedInBody>(login, "/api/auth/login", { jar: new Jar(), body: { email, password: NEW_PASSWORD } });
    expect(fresh.status).toBe(200);
    expect(fresh.body.session.uid).toBe(uid);
  });

  it("answers 202 without a mail for an unknown e-mail, in no less time than for a real one, and limits requests per e-mail", async () => {
    const ghost = uniqueEmail("ghost");
    const startedAt = Date.now();
    const result = await call<{ status: string }>(resetRequest, "/api/auth/password/reset", { jar: new Jar(), body: { email: ghost, turnstileToken: "t" } });
    // Node timers never fire early beyond millisecond rounding.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(UNIFORM_RESPONSE_MS - 5);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ status: "sent" });
    expect(capturedMails(sendMail)).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) expect((await call(resetRequest, "/api/auth/password/reset", { jar: new Jar(), body: { email: ghost, turnstileToken: "t" } })).status).toBe(202);
    const limited = await call<ErrorBody>(resetRequest, "/api/auth/password/reset", { jar: new Jar(), body: { email: ghost.replace("@", "+other@"), turnstileToken: "t" } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    const bad = await call<ErrorBody>(action, "/api/auth/action", { jar: new Jar(), body: { mode: "resetPassword", oobCode: "definitely-not-a-code" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_code");
  });

  it("mails a reset link to a Google-only account, which has no password yet", async () => {
    const email = uniqueEmail("gonly");
    const record = await auth().createUser({ email, emailVerified: true, displayName: "Nadia" });
    expect(record.providerData.some((provider) => provider.providerId === "password")).toBe(false);
    const result = await call<{ status: string }>(resetRequest, "/api/auth/password/reset", { jar: new Jar(), body: { email, locale: "fr", turnstileToken: "t" } });
    expect(result.status).toBe(202);
    expect(lastMail(sendMail, "resetPassword", email)).toBeDefined();
  });

  it("never mails nor resets a staff account from the public host", async () => {
    const email = uniqueEmail("staff");
    const record = await auth().createUser({ email, password: PASSWORD, emailVerified: true, displayName: "Admin Person" });
    await setClaims(record.uid, { role: "admin", v: 2 });
    const requested = await call<{ status: string }>(resetRequest, "/api/auth/password/reset", { jar: new Jar(), body: { email, turnstileToken: "t" } });
    expect(requested.status).toBe(202);
    expect(requested.body).toEqual({ status: "sent" });
    expect(lastMail(sendMail, "resetPassword", email)).toBeUndefined();

    // Even with a genuine code (the back-office flow issues its own), the public confirm refuses it.
    const oobCode = oobCodeOf(await auth().generatePasswordResetLink(email, { url: "http://localhost:3000/fr/action" }));
    const refused = await call<ErrorBody>(resetConfirm, "/api/auth/password/confirm", { jar: new Jar(), body: { oobCode, password: NEW_PASSWORD } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("invalid_code");
    expect(lastMail(sendMail, "passwordChanged", email)).toBeUndefined();
  });
});

describe("POST /api/auth/password/change", () => {
  it("re-authenticates, changes the password, keeps this device signed in and revokes the others", async () => {
    const { jar, email, uid } = await verifiedAccount("Change Tester");
    const other = new Jar();
    expect((await call<SignedInBody>(login, "/api/auth/login", { jar: other, body: { email, password: PASSWORD } })).status).toBe(200);

    const wrong = await call<ErrorBody>(passwordChange, "/api/auth/password/change", { jar, body: { currentPassword: "not-it-at-all-1", password: NEW_PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("invalid_credentials");
    const weak = await call<ErrorBody>(passwordChange, "/api/auth/password/change", { jar, body: { currentPassword: PASSWORD, password: "change-tester-1" } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("weak_password");
    const noCsrf = await call<ErrorBody>(passwordChange, "/api/auth/password/change", { jar, csrf: false, body: { currentPassword: PASSWORD, password: NEW_PASSWORD } });
    expect(noCsrf.status).toBe(403);

    await nextSecond();
    const oldCookie = jar.get("__Host-session");
    const changed = await call<SignedInBody>(passwordChange, "/api/auth/password/change", { jar, body: { currentPassword: PASSWORD, password: NEW_PASSWORD } });
    expect(changed.status).toBe(200);
    expect(changed.body.status).toBe("changed");
    expect(changed.body.session.uid).toBe(uid);
    expect(jar.get("__Host-session")).not.toBe(oldCookie);
    expect(changed.header("x-csrf-token")).toBe(jar.get("__Host-csrf"));
    expect(lastMail(sendMail, "passwordChanged", email)).toBeDefined();

    expect(await sessionAlive(jar)).toBe(true);
    expect(await sessionAlive(other)).toBe(false);
    expect((await verifySession(oldCookie, { checkRevoked: true }))).toBeNull();
    expect((await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar })).body.session?.uid).toBe(uid);
    expect((await call<SignedInBody>(login, "/api/auth/login", { jar: new Jar(), body: { email, password: NEW_PASSWORD } })).status).toBe(200);

    // The revoked cookie reads and mutates nothing any more: no conversation (checkRevoked, D2), signed out on /me.
    const stale = new Jar();
    stale.cookies.set("__Host-session", oldCookie!);
    stale.cookies.set("__Host-csrf", csrfToken(oldCookie!));
    const conversations = await call<ErrorBody>(inbox, "/api/conversations", { jar: stale });
    expect(conversations.status).toBe(401);
    expect(conversations.body.error.code).toBe("unauthenticated");
    expect((await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar: stale })).body.session).toBeNull();
    const otherConversations = await call<ErrorBody>(inbox, "/api/conversations", { jar: other });
    expect(otherConversations.status).toBe(401);
  });
});
