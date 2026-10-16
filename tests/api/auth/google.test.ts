import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGoogleVerifierForTests, type GoogleIdentity } from "@/lib/auth/google";
import { findUidByEmail, getUser, getUserPrivate } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { signInWithCustomToken } from "@/lib/firebase/rest";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import type * as Turnstile from "@/lib/security/turnstile";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { POST as google } from "@/app/api/auth/google/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as session } from "@/app/api/auth/session/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { CONSENTS, Jar, PASSWORD, call, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

const GOOGLE = "/api/auth/google";
/** The nonce the page would have generated for GIS; the token must carry the same one. */
const NONCE = "page-nonce-0123456789abcdef";

/** The test verifier reads the identity from the credential itself (no Google keys in tests). */
function credential(identity: Partial<GoogleIdentity> & { email: string }): string {
  return JSON.stringify({ sub: `g-${identity.email}`, emailVerified: true, name: "Nadia Google", nonce: NONCE, ...identity });
}

/** Request body of a Google call: the credential and the page nonce, plus the sign-up fields. */
function body(identity: Partial<GoogleIdentity> & { email: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { credential: credential(identity), nonce: NONCE, ...extra };
}

beforeAll(() => setGoogleVerifierForTests(async (value) => JSON.parse(value) as GoogleIdentity));
beforeEach(() => resetRateLimiters());

describe("POST /api/auth/google", () => {
  it("asks for the consents on a first sign-in, then creates the account, then signs in directly", async () => {
    const email = uniqueEmail("g");
    const jar = new Jar();
    const first = await call<{ status: string; email: string; displayName: string | null }>(google, GOOGLE, { jar, body: body({ email }) });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "needs_consent", email, displayName: "Nadia Google" });
    expect(await findUidByEmail(email)).toBeNull();
    expect(jar.get("__Host-session")).toBeUndefined();

    const noToken = await call<ErrorBody>(google, GOOGLE, { jar, body: body({ email }, { consents: CONSENTS }) });
    expect(noToken.status).toBe(400);
    expect(noToken.body.error.code).toBe("invalid_body");

    const created = await call<SignedInBody>(google, GOOGLE, { jar, body: body({ email }, { consents: CONSENTS, turnstileToken: "t", locale: "ar" }) });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("signed_in");
    expect(created.body.session).toMatchObject({ email, role: "individual", emailVerified: true, displayName: "Nadia Google", locale: "ar", providers: ["google.com"] });
    expect(vi.mocked(verifyTurnstile)).toHaveBeenLastCalledWith("t", expect.objectContaining({ action: "google" }));
    expect(created.header("x-csrf-token")).toBe(jar.get("__Host-csrf"));
    const record = await auth().getUser(created.body.session.uid);
    expect(record.emailVerified).toBe(true);
    expect(record.providerData.map((p) => [p.providerId, p.uid])).toContainEqual(["google.com", `g-${email}`]);

    const again = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: body({ email, name: "Renamed Later" }) });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("signed_in");
    expect(again.body.session.uid).toBe(created.body.session.uid);
    expect(again.body.session.displayName).toBe("Nadia Google");
    expect((await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar })).body.session?.uid).toBe(created.body.session.uid);
  });

  it("refuses a token minted for another page (nonce) and a body without nonce", async () => {
    const email = uniqueEmail("gn");
    const replay = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: body({ email, nonce: "other-page-nonce-9876543210" }) });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe("invalid_credentials");
    const noNonce = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: body({ email, nonce: null }) });
    expect(noNonce.status).toBe(403);
    const missing = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email }) } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_body");
    expect(await findUidByEmail(email)).toBeNull();
  });

  it("links Google to a pending password account, activates it and drops the unverified password (pre-hijack)", async () => {
    // The attacker opens a password account with the victim's e-mail and never verifies it.
    const email = uniqueEmail("gp");
    const signupJar = new Jar();
    expect((await call(signup, "/api/auth/signup", { jar: signupJar, body: { email, password: PASSWORD, displayName: "Pending Person", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
    const pendingUid = await findUidByEmail(email);
    expect((await auth().getUser(pendingUid!)).customClaims?.role).toBeUndefined();

    // The victim signs in with Google: same account, activated, but the attacker's password is gone.
    const linked = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: body({ email, sub: "g-fixed-sub" }) });
    expect(linked.status).toBe(200);
    expect(linked.body.status).toBe("signed_in");
    expect(linked.body.session.uid).toBe(pendingUid);
    expect(linked.body.session.role).toBe("individual");
    expect(linked.body.session.emailVerified).toBe(true);
    expect(linked.body.session.displayName).toBe("Pending Person");
    expect(linked.body.session.providers).toEqual(["google.com"]);
    expect((await getUserPrivate(pendingUid!))?.providers).toEqual(["google.com"]);
    const record = await auth().getUser(pendingUid!);
    expect(record.emailVerified).toBe(true);
    expect(record.customClaims).toMatchObject({ role: "individual", v: 2 });
    expect(record.providerData.find((p) => p.providerId === "google.com")?.uid).toBe("g-fixed-sub");

    const attacker = await call<ErrorBody>(login, "/api/auth/login", { jar: new Jar(), body: { email, password: PASSWORD } });
    expect(attacker.status).toBe(401);
    expect(attacker.body.error.code).toBe("invalid_credentials");
  });

  it("keeps the password of a verified account when Google is linked to it", async () => {
    const email = uniqueEmail("gv");
    expect((await call(signup, "/api/auth/signup", { jar: new Jar(), body: { email, password: PASSWORD, displayName: "Verified Person", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
    const uid = (await findUidByEmail(email))!;
    await auth().updateUser(uid, { emailVerified: true });
    const linked = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: body({ email }) });
    expect(linked.status).toBe(200);
    expect(linked.body.session.uid).toBe(uid);
    expect([...linked.body.session.providers].sort()).toEqual(["google.com", "password"]);
    expect((await call<SignedInBody>(login, "/api/auth/login", { jar: new Jar(), body: { email, password: PASSWORD } })).status).toBe(200);
  });

  it("never signs a +tag variant into another account: 409 instead of a merge", async () => {
    const email = uniqueEmail("gt");
    expect((await call(signup, "/api/auth/signup", { jar: new Jar(), body: { email, password: PASSWORD, displayName: "Tag Owner", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
    const owner = (await findUidByEmail(email))!;
    const variant = email.replace("@", "+google@");
    const refused = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: body({ email: variant }) });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
    const withConsents = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: body({ email: variant }, { consents: CONSENTS, turnstileToken: "t" }) });
    expect(withConsents.status).toBe(409);
    expect((await auth().getUser(owner)).providerData.map((p) => p.providerId)).toEqual(["password"]);
    expect((await auth().getUser(owner)).emailVerified).toBe(false);
  });

  it("counts a needs_consent pass in the sign-up limits (3 per day per device)", async () => {
    const ip = new Jar().ip;
    for (let i = 0; i < 3; i += 1) expect((await call(google, GOOGLE, { ip, body: body({ email: uniqueEmail("gl") }) })).status).toBe(200);
    const limited = await call<ErrorBody>(google, GOOGLE, { ip, body: body({ email: uniqueEmail("gl") }) });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    // An existing account still signs in from that device.
    const email = uniqueEmail("gl");
    const created = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: body({ email }, { consents: CONSENTS, turnstileToken: "t" }) });
    expect(created.status).toBe(200);
    expect((await call<SignedInBody>(google, GOOGLE, { ip, body: body({ email }) })).status).toBe(200);
  });

  it("never turns a staff account into a member: 403, claims and roster untouched", async () => {
    const email = uniqueEmail("staff");
    const staff = await auth().createUser({ email, emailVerified: true, displayName: "Modo" });
    await setClaims(staff.uid, { role: "admin" });
    const jar = new Jar();
    const first = await call<ErrorBody>(google, GOOGLE, { jar, body: body({ email }) });
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe("forbidden");
    const withConsents = await call<ErrorBody>(google, GOOGLE, { jar, body: body({ email }, { consents: CONSENTS, turnstileToken: "t" }) });
    expect(withConsents.status).toBe(403);
    expect((await auth().getUser(staff.uid)).customClaims).toMatchObject({ role: "admin" });
    expect(await getUser(staff.uid)).toBeNull();
    expect(jar.get("__Host-session")).toBeUndefined();
  });

  it("refuses an unverified Google e-mail and a disabled account", async () => {
    const unverified = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: body({ email: uniqueEmail("gu"), emailVerified: false }) });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe("email_not_verified");

    const email = uniqueEmail("gd");
    const created = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: body({ email }, { consents: CONSENTS, turnstileToken: "t" }) });
    await auth().updateUser(created.body.session.uid, { disabled: true });
    const disabled = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: body({ email }) });
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe("account_disabled");
  });
});

describe("POST /api/auth/session", () => {
  it("refuses an ID token that does not come from a Google sign-in", async () => {
    const email = uniqueEmail("s");
    const created = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: body({ email }, { consents: CONSENTS, turnstileToken: "t" }) });
    const custom = await auth().createCustomToken(created.body.session.uid);
    const { idToken } = await signInWithCustomToken(custom);
    const refused = await call<ErrorBody>(session, "/api/auth/session", { jar: new Jar(), body: { idToken } });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("invalid_credentials");
    const garbage = await call<ErrorBody>(session, "/api/auth/session", { jar: new Jar(), body: { idToken: "x".repeat(40) } });
    expect(garbage.status).toBe(401);
  });
});
