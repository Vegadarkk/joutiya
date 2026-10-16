import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGoogleVerifierForTests, type GoogleIdentity } from "@/lib/auth/google";
import { findUidByEmail } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { signInWithCustomToken } from "@/lib/firebase/rest";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import type * as Turnstile from "@/lib/security/turnstile";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { POST as google } from "@/app/api/auth/google/route";
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

/** The test verifier reads the identity from the credential itself (no Google keys in tests). */
function credential(identity: Partial<GoogleIdentity> & { email: string }): string {
  return JSON.stringify({ sub: `g-${identity.email}`, emailVerified: true, name: "Nadia Google", ...identity });
}

beforeAll(() => setGoogleVerifierForTests(async (value) => JSON.parse(value) as GoogleIdentity));
beforeEach(() => resetRateLimiters());

describe("POST /api/auth/google", () => {
  it("asks for the consents on a first sign-in, then creates the account, then signs in directly", async () => {
    const email = uniqueEmail("g");
    const jar = new Jar();
    const first = await call<{ status: string; email: string; displayName: string | null }>(google, GOOGLE, { jar, body: { credential: credential({ email }) } });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "needs_consent", email, displayName: "Nadia Google" });
    expect(await findUidByEmail(email)).toBeNull();
    expect(jar.get("__Host-session")).toBeUndefined();

    const noToken = await call<ErrorBody>(google, GOOGLE, { jar, body: { credential: credential({ email }), consents: CONSENTS } });
    expect(noToken.status).toBe(400);
    expect(noToken.body.error.code).toBe("invalid_body");

    const created = await call<SignedInBody>(google, GOOGLE, { jar, body: { credential: credential({ email }), consents: CONSENTS, turnstileToken: "t", locale: "ar" } });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("signed_in");
    expect(created.body.session).toMatchObject({ email, role: "individual", emailVerified: true, displayName: "Nadia Google", locale: "ar", providers: ["google.com"] });
    expect(vi.mocked(verifyTurnstile)).toHaveBeenLastCalledWith("t", expect.objectContaining({ action: "google" }));
    expect(created.header("x-csrf-token")).toBe(jar.get("__Host-csrf"));
    const record = await auth().getUser(created.body.session.uid);
    expect(record.emailVerified).toBe(true);
    expect(record.providerData.map((p) => [p.providerId, p.uid])).toContainEqual(["google.com", `g-${email}`]);

    const again = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email, name: "Renamed Later" }) } });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("signed_in");
    expect(again.body.session.uid).toBe(created.body.session.uid);
    expect(again.body.session.displayName).toBe("Nadia Google");
    expect((await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar })).body.session?.uid).toBe(created.body.session.uid);
  });

  it("links Google to an existing password account and activates a pending one", async () => {
    const email = uniqueEmail("gp");
    const signupJar = new Jar();
    expect((await call(signup, "/api/auth/signup", { jar: signupJar, body: { email, password: PASSWORD, displayName: "Pending Person", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
    const pendingUid = await findUidByEmail(email);
    expect((await auth().getUser(pendingUid!)).customClaims?.role).toBeUndefined();

    const linked = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email, sub: "g-fixed-sub" }) } });
    expect(linked.status).toBe(200);
    expect(linked.body.status).toBe("signed_in");
    expect(linked.body.session.uid).toBe(pendingUid);
    expect(linked.body.session.role).toBe("individual");
    expect(linked.body.session.emailVerified).toBe(true);
    expect(linked.body.session.displayName).toBe("Pending Person");
    expect([...linked.body.session.providers].sort()).toEqual(["google.com", "password"]);
    const record = await auth().getUser(pendingUid!);
    expect(record.emailVerified).toBe(true);
    expect(record.customClaims).toMatchObject({ role: "individual", v: 2 });
    expect(record.providerData.map((p) => p.providerId).sort()).toEqual(["google.com", "password"]);
    expect(record.providerData.find((p) => p.providerId === "google.com")?.uid).toBe("g-fixed-sub");
  });

  it("refuses an unverified Google e-mail and a disabled account", async () => {
    const unverified = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email: uniqueEmail("gu"), emailVerified: false }) } });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe("email_not_verified");

    const email = uniqueEmail("gd");
    const created = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email }), consents: CONSENTS, turnstileToken: "t" } });
    await auth().updateUser(created.body.session.uid, { disabled: true });
    const disabled = await call<ErrorBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email }) } });
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe("account_disabled");
  });
});

describe("POST /api/auth/session", () => {
  it("refuses an ID token that does not come from a Google sign-in", async () => {
    const email = uniqueEmail("s");
    const created = await call<SignedInBody>(google, GOOGLE, { jar: new Jar(), body: { credential: credential({ email }), consents: CONSENTS, turnstileToken: "t" } });
    const custom = await auth().createCustomToken(created.body.session.uid);
    const { idToken } = await signInWithCustomToken(custom);
    const refused = await call<ErrorBody>(session, "/api/auth/session", { jar: new Jar(), body: { idToken } });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("invalid_credentials");
    const garbage = await call<ErrorBody>(session, "/api/auth/session", { jar: new Jar(), body: { idToken: "x".repeat(40) } });
    expect(garbage.status).toBe(401);
  });
});
