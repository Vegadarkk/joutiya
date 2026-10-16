import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNIFORM_RESPONSE_MS } from "@/lib/auth/anonymous";
import { deleteAccountDocumentsIfPending, findUidByEmail, getUser, getUserPrivate } from "@/lib/db/repositories/users";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import type { TemplateMail } from "@/lib/mail/types";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import type * as Turnstile from "@/lib/security/turnstile";
import { POST as action } from "@/app/api/auth/action/route";
import { POST as clientToken } from "@/app/api/auth/client-token/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as profile } from "@/app/api/auth/profile/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verifyResend } from "@/app/api/auth/verify/resend/route";
import { CONSENTS, Jar, PASSWORD, call, capturedMails, lastMail, oobCodeOf, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

const SIGNUP = "/api/auth/signup";
const ACTION = "/api/auth/action";
const ME = "/api/auth/me";
const PROFILE = "/api/auth/profile";

function signupBody(email: string, displayName = "Yasmine Test") {
  return { email, password: PASSWORD, displayName, locale: "fr", consents: CONSENTS, turnstileToken: "test-token" };
}

async function signUp(jar: Jar, email: string, displayName?: string) {
  const result = await call<{ status: string }>(signup, SIGNUP, { jar, body: signupBody(email, displayName) });
  expect(result.status).toBe(202);
  expect(result.body).toEqual({ status: "verification_sent" });
  const mail = lastMail(sendMail, "verifyEmail", email);
  expect(mail).toBeDefined();
  return mail!;
}

async function verify(jar: Jar, actionUrl: string) {
  const result = await call<SignedInBody>(action, ACTION, { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(actionUrl) } });
  expect(result.status).toBe(200);
  expect(result.body.status).toBe("verified");
  return result;
}

/** Events logged for this account (connectionLogs, §5), in order. */
async function loggedEvents(uid: string): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.connectionLogs).where("uid", "==", uid).get();
  return snapshot.docs
    .map((doc) => ({ event: String(doc.get("event")), at: doc.get("at").toMillis() as number }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.event);
}

/** Revocation has a one-second granularity (auth_time vs tokensValidAfterTime): sessions minted in the same second survive. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

beforeEach(() => resetRateLimiters());

describe("sign-up, verification, session, profile, logout", () => {
  it("creates a pending account, activates it from the mail link and opens a session", async () => {
    const jar = new Jar();
    const email = uniqueEmail();
    expect((await call<{ session: null }>(me, ME, { jar })).body.session).toBeNull();

    const mail = await signUp(jar, email);
    expect(jar.get("__Host-did")).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(jar.get("__Host-tsv")).toBeDefined();
    expect(jar.get("__Host-session")).toBeUndefined();
    expect(mail.priority).toBe("security");
    expect(mail.data.actionUrl).toMatch(/^http:\/\/localhost:3000\/fr\/action\?mode=verifyEmail&oobCode=/);
    expect(mail.idempotencyKey).toMatch(/^verify-.+-\d+$/);

    const verified = await verify(jar, mail.data.actionUrl);
    const { session } = verified.body;
    expect(session.role).toBe("individual");
    expect(session.emailVerified).toBe(true);
    expect(session.displayName).toBe("Yasmine Test");
    expect(session.email).toBe(email);
    expect(session.providers).toEqual(["password"]);
    expect(session.publicId).toMatch(/^[a-hj-km-np-z2-9]{10}$/);
    expect(verified.header("x-csrf-token")).toBe(jar.get("__Host-csrf"));
    expect(jar.get("__Host-session")).toBeDefined();
    expect(verified.response.headers.get("cache-control")).toBe("no-store");

    // The same code cannot be used twice.
    const again = await call<ErrorBody>(action, ACTION, { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(mail.data.actionUrl) } });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_code");

    const who = await call<{ session: SignedInBody["session"] }>(me, ME, { jar });
    expect(who.body.session?.uid).toBe(session.uid);
    expect(who.header("x-csrf-token")).toBe(jar.get("__Host-csrf"));
    // The sign-up and the sign-in from the verification link are both in connectionLogs.
    expect(await loggedEvents(session.uid)).toEqual(["signup", "login"]);

    // Mutations need the Origin header and the CSRF header.
    const noCsrf = await call<ErrorBody>(profile, PROFILE, { jar, csrf: false, body: { displayName: "Nope" } });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("csrf");
    const noOrigin = await call<ErrorBody>(profile, PROFILE, { jar, origin: null, body: { displayName: "Nope" } });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("origin");
    const foreign = await call<ErrorBody>(profile, PROFILE, { jar, origin: "https://evil.example", body: { displayName: "Nope" } });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("origin");

    const updated = await call<{ session: SignedInBody["session"] }>(profile, PROFILE, { jar, body: { displayName: "Yasmine B.", locale: "ar" } });
    expect(updated.status).toBe(200);
    expect(updated.body.session.displayName).toBe("Yasmine B.");
    expect(updated.body.session.locale).toBe("ar");

    const token = await call<{ token: string }>(clientToken, "/api/auth/client-token", { jar, body: {} });
    expect(token.status).toBe(200);
    expect(token.body.token.split(".")).toHaveLength(3);
    const tokenNoCsrf = await call<ErrorBody>(clientToken, "/api/auth/client-token", { jar, csrf: false, body: {} });
    expect(tokenNoCsrf.status).toBe(403);

    await nextSecond();
    const stale = new Jar();
    stale.cookies.set("__Host-session", jar.get("__Host-session")!);
    stale.cookies.set("__Host-csrf", jar.get("__Host-csrf")!);
    const out = await call<null>(logout, "/api/auth/logout", { jar, body: {} });
    expect(out.status).toBe(204);
    expect(jar.get("__Host-session")).toBeUndefined();
    expect(jar.get("__Host-csrf")).toBeUndefined();
    expect((await call<{ session: null }>(me, ME, { jar })).body.session).toBeNull();
    const anonymous = await call<ErrorBody>(profile, PROFILE, { jar, body: { displayName: "Ghost" } });
    expect(anonymous.status).toBe(401);
    // A copy of the cookie kept from before the logout is revoked: no SDK token, no mutation, signed out.
    const staleToken = await call<ErrorBody>(clientToken, "/api/auth/client-token", { jar: stale, body: {} });
    expect(staleToken.status).toBe(401);
    expect(staleToken.body.error.code).toBe("unauthenticated");
    expect((await call<ErrorBody>(profile, PROFILE, { jar: stale, body: { displayName: "Ghost" } })).status).toBe(401);
    expect((await call<{ session: null }>(me, ME, { jar: stale })).body.session).toBeNull();
    expect(await loggedEvents(session.uid)).toEqual(["signup", "login", "logout"]);
  });

  it("answers an existing e-mail exactly like a new one and warns the owner by mail", async () => {
    const email = uniqueEmail();
    const first = await signUp(new Jar(), email);
    expect(first.template).toBe("verifyEmail");
    const before = capturedMails(sendMail).length;
    const second = await call<{ status: string }>(signup, SIGNUP, { jar: new Jar(), body: signupBody(email, "Someone Else") });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ status: "verification_sent" });
    const mails = capturedMails(sendMail).slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.template).toBe("signupExisting");
    expect(mails[0]?.to).toBe(email);
    expect(mails[0]?.priority).toBe("security");
    expect(mails[0]?.idempotencyKey).toMatch(/^signup-existing-.+-\d+$/);
    expect(mails[0]?.data).toMatchObject({ displayName: "Yasmine Test", loginUrl: "http://localhost:3000/fr/connexion", resetUrl: "http://localhost:3000/fr/mot-de-passe-oublie" });
    // Gmail-style variants are the same account.
    const variant = await call<{ status: string }>(signup, SIGNUP, { jar: new Jar(), body: signupBody(email.replace("@", "+tag@")) });
    expect(variant.status).toBe(202);
    expect(lastMail(sendMail, "signupExisting")?.to).toBe(email);
    // Mail bombing: three warnings per hour per address, variants included; the answer never changes.
    expect((await call(signup, SIGNUP, { jar: new Jar(), body: signupBody(email.replace("@", "+again@")) })).status).toBe(202);
    const warned = capturedMails(sendMail).filter((mail) => mail.template === "signupExisting" && mail.to === email).length;
    expect(warned).toBe(3);
    const fourth = await call<{ status: string }>(signup, SIGNUP, { jar: new Jar(), body: signupBody(email, "Yet Another") });
    expect(fourth.status).toBe(202);
    expect(fourth.body).toEqual({ status: "verification_sent" });
    expect(capturedMails(sendMail).filter((mail) => mail.template === "signupExisting" && mail.to === email)).toHaveLength(warned);
  });

  it("refuses weak passwords, disposable domains and malformed bodies", async () => {
    const weak = await call<ErrorBody>(signup, SIGNUP, { jar: new Jar(), body: { ...signupBody(uniqueEmail()), password: "password123" } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("weak_password");
    const personal = await call<ErrorBody>(signup, SIGNUP, { jar: new Jar(), body: { ...signupBody(uniqueEmail(), "Yasmine Test"), password: "yasmine-test-2026" } });
    expect(personal.body.error.code).toBe("weak_password");
    const disposable = await call<ErrorBody>(signup, SIGNUP, { jar: new Jar(), body: signupBody("someone@mailinator.com") });
    expect(disposable.status).toBe(400);
    expect(disposable.body.error.code).toBe("disposable_email");
    const consent = await call<ErrorBody>(signup, SIGNUP, { jar: new Jar(), body: { ...signupBody(uniqueEmail()), consents: { cgu: true, transfers: false } } });
    expect(consent.status).toBe(400);
    expect(consent.body.error.code).toBe("invalid_body");
    const extra = await call<ErrorBody>(signup, SIGNUP, { jar: new Jar(), body: { ...signupBody(uniqueEmail()), role: "admin" } });
    expect(extra.body.error.code).toBe("invalid_body");
    expect(capturedMails(sendMail)).toHaveLength(0);
  });

  it("limits sign-ups per device, unknown devices counting on their IP", async () => {
    // Without a device cookie: three per IP, then 429 (the cookie is set by every answer).
    const ip = new Jar().ip;
    for (let i = 0; i < 3; i += 1) expect((await call(signup, SIGNUP, { ip, body: signupBody(uniqueEmail()) })).status).toBe(202);
    const anonymous = await call<ErrorBody>(signup, SIGNUP, { ip, body: signupBody(uniqueEmail()) });
    expect(anonymous.status).toBe(429);
    expect(anonymous.body.error.code).toBe("rate_limited");
    expect(anonymous.header("retry-after")).toBeTruthy();
    expect(anonymous.response.headers.getSetCookie().some((line) => line.startsWith("__Host-did="))).toBe(true);
    // With the cookie: three per device.
    const jar = new Jar();
    expect((await call(signup, SIGNUP, { jar, body: signupBody(uniqueEmail()) })).status).toBe(202);
    for (let i = 0; i < 3; i += 1) expect((await call(signup, SIGNUP, { jar, body: signupBody(uniqueEmail()) })).status).toBe(202);
    const fifth = await call<ErrorBody>(signup, SIGNUP, { jar, body: signupBody(uniqueEmail()) });
    expect(fifth.status).toBe(429);
  });

  it("resends the verification mail to a pending account only", async () => {
    const email = uniqueEmail();
    const jar = new Jar();
    const first = await signUp(jar, email);
    const resend = await call<{ status: string }>(verifyResend, "/api/auth/verify/resend", { jar: new Jar(), body: { email, turnstileToken: "t" } });
    expect(resend.status).toBe(202);
    expect(resend.body).toEqual({ status: "verification_sent" });
    const mails = capturedMails(sendMail).filter((mail): mail is TemplateMail<"verifyEmail"> => mail.template === "verifyEmail" && mail.to === email);
    expect(mails).toHaveLength(2);
    expect(mails[1]?.data.actionUrl).not.toBe(first.data.actionUrl);

    await verify(jar, first.data.actionUrl);
    const verifiedResend = await call<{ status: string }>(verifyResend, "/api/auth/verify/resend", { jar: new Jar(), body: { email, turnstileToken: "t" } });
    expect(verifiedResend.status).toBe(202);
    // An unknown e-mail takes no less time than a pending account (timing enumeration).
    const startedAt = Date.now();
    const unknown = await call<{ status: string }>(verifyResend, "/api/auth/verify/resend", { jar: new Jar(), body: { email: uniqueEmail("ghost"), turnstileToken: "t" } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(UNIFORM_RESPONSE_MS - 5);
    expect(unknown.status).toBe(202);
    expect(capturedMails(sendMail).filter((mail) => mail.template === "verifyEmail")).toHaveLength(2);
  });

  it("purges the documents of a pending account only (deleteAccountDocumentsIfPending)", async () => {
    const pendingEmail = uniqueEmail("purge");
    await signUp(new Jar(), pendingEmail);
    const pendingUid = (await findUidByEmail(pendingEmail))!;
    expect(await deleteAccountDocumentsIfPending(pendingUid)).toBe(true);
    expect(await getUser(pendingUid)).toBeNull();
    expect(await getUserPrivate(pendingUid)).toBeNull();
    expect(await findUidByEmail(pendingEmail)).toBeNull();
    // Gone already, or never existed: nothing to do.
    expect(await deleteAccountDocumentsIfPending(pendingUid)).toBe(false);
    expect(await deleteAccountDocumentsIfPending("no-such-uid")).toBe(false);

    // An activated account is never purged.
    const jar = new Jar();
    const activeEmail = uniqueEmail("keep");
    const verified = await verify(jar, (await signUp(jar, activeEmail)).data.actionUrl);
    const activeUid = verified.body.session.uid;
    expect(await deleteAccountDocumentsIfPending(activeUid)).toBe(false);
    expect((await getUser(activeUid))?.activation).toBe("done");
    expect(await findUidByEmail(activeEmail)).toBe(activeUid);
  });

  it("IDOR: a session only ever changes its own profile", async () => {
    const jarA = new Jar();
    const emailA = uniqueEmail("a");
    const verifiedA = await verify(jarA, (await signUp(jarA, emailA, "Alice Owner")).data.actionUrl);
    const jarB = new Jar();
    const emailB = uniqueEmail("b");
    const verifiedB = await verify(jarB, (await signUp(jarB, emailB, "Bob Other")).data.actionUrl);

    const attack = await call<{ session: SignedInBody["session"] }>(profile, PROFILE, { jar: jarB, body: { displayName: "Bob Hacker" } });
    expect(attack.status).toBe(200);
    expect(attack.body.session.uid).toBe(verifiedB.body.session.uid);
    expect(attack.body.session.displayName).toBe("Bob Hacker");

    const alice = await call<{ session: SignedInBody["session"] }>(me, ME, { jar: jarA });
    expect(alice.body.session?.uid).toBe(verifiedA.body.session.uid);
    expect(alice.body.session?.displayName).toBe("Alice Owner");

    // A's CSRF token is useless with B's session cookie.
    const mixed = await call<ErrorBody>(profile, PROFILE, { jar: jarB, csrf: false, headers: { "x-csrf-token": jarA.get("__Host-csrf")! }, body: { displayName: "Mixed" } });
    expect(mixed.status).toBe(403);
    expect(mixed.body.error.code).toBe("csrf");
  });
});
