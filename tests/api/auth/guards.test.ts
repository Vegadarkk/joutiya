import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/auth/guards";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid, revokeSessions } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import type * as Turnstile from "@/lib/security/turnstile";
import { POST as action } from "@/app/api/auth/action/route";
import { POST as clientToken } from "@/app/api/auth/client-token/route";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as phoneStatus } from "@/app/api/auth/phone/status/route";
import { POST as profile } from "@/app/api/auth/profile/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as myListings } from "@/app/api/listings/mine/route";
import { CONSENTS, Jar, ORIGIN, PASSWORD, call, lastMail, oobCodeOf, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

// Guards on a suspended account (§6 "Contrôle d'accès"): the session is refused everywhere except
// on the routes that opt in (conversations, export, appeal).

async function verifiedAccount() {
  const jar = new Jar();
  const email = uniqueEmail("gs");
  expect((await call(signup, "/api/auth/signup", { jar, body: { email, password: PASSWORD, displayName: "Suspended Soon", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
  const verified = await call<SignedInBody>(action, "/api/auth/action", { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(lastMail(sendMail, "verifyEmail", email)!.data.actionUrl) } });
  expect(verified.status).toBe(200);
  return { jar, uid: verified.body.session.uid };
}

/** A jar carrying a session minted by the server for `uid` (after a claims change, which revokes the previous one). */
async function jarFor(uid: string): Promise<Jar> {
  const minted = await createSessionForUid(uid);
  const jar = new Jar();
  jar.cookies.set("__Host-session", minted.cookie);
  jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return jar;
}

function requestWith(jar: Jar): Request {
  return new Request(`${ORIGIN}/api/anything`, { method: "POST", headers: { host: "localhost:3000", origin: ORIGIN, cookie: jar.header() ?? "", "x-csrf-token": jar.get("__Host-csrf") ?? "" } });
}

/** Revocation has a one-second granularity (auth_time vs tokensValidAfterTime): sessions minted in the same second survive. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

beforeEach(() => resetRateLimiters());

describe("revoked session cookie", () => {
  it("is refused on GET routes too, not only on mutations: /api/listings/mine and /api/auth/phone/status answer 401", async () => {
    const { jar, uid } = await verifiedAccount();
    expect((await call(myListings, "/api/listings/mine", { jar })).status).toBe(200);
    expect((await call(phoneStatus, "/api/auth/phone/status", { jar })).status).toBe(200);

    // The cookie is copied before a logout, password change or ban revokes the account's sessions.
    await nextSecond();
    await revokeSessions(uid);
    const listings = await call<ErrorBody>(myListings, "/api/listings/mine", { jar });
    expect(listings.status).toBe(401);
    expect(listings.body.error.code).toBe("unauthenticated");
    const phone = await call<ErrorBody>(phoneStatus, "/api/auth/phone/status", { jar });
    expect(phone.status).toBe(401);
    expect(phone.body.error.code).toBe("unauthenticated");
    // requireUser checks revocation by default (the explicit `checkRevoked: false` opt-out cannot be
    // observed here: the Admin SDK always checks revocation against the Auth emulator).
    await expect(requireUser(requestWith(jar))).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });
});

describe("suspended account", () => {
  it("answers 403 account_suspended unless the route allows suspended members", async () => {
    const { uid } = await verifiedAccount();
    await setClaims(uid, { role: "individual", st: "suspended" });
    const jar = await jarFor(uid);

    const who = await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar });
    expect(who.body.session).toMatchObject({ uid, suspended: true });
    const refused = await call<ErrorBody>(profile, "/api/auth/profile", { jar, body: { displayName: "Still Me" } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("account_suspended");
    const token = await call<ErrorBody>(clientToken, "/api/auth/client-token", { jar, body: {} });
    expect(token.status).toBe(403);
    expect(token.body.error.code).toBe("account_suspended");

    await expect(requireUser(requestWith(jar), { mutation: true })).rejects.toMatchObject({ status: 403, code: "account_suspended" });
    const allowed = await requireUser(requestWith(jar), { mutation: true, allowSuspended: true });
    expect(allowed.user.uid).toBe(uid);
    expect(allowed.user.claims.st).toBe("suspended");
  });
});
