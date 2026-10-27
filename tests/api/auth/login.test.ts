import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS } from "@/config/rate-limits";
import { TURNSTILE_AFTER_FAILURES } from "@/lib/auth/login";
import { auth } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { signInWithPassword } from "@/lib/firebase/rest";
import { sendMail } from "@/lib/mail";
import { consumeLimit, limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";
import type * as Turnstile from "@/lib/security/turnstile";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { POST as action } from "@/app/api/auth/action/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { CONSENTS, Jar, PASSWORD, actionUrlOf, call, freshIp, lastMail, oobCodeOf, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });
// Spies around the real Identity Toolkit calls: counts how many password checks a burst reaches.
vi.mock("@/lib/firebase/rest", { spy: true });
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

const LOGIN = "/api/auth/login";

async function createAccount(verified: boolean, displayName = "Login Tester") {
  const jar = new Jar();
  const email = uniqueEmail("l");
  const created = await call(signup, "/api/auth/signup", { jar, body: { email, password: PASSWORD, displayName, locale: "fr", consents: CONSENTS, turnstileToken: "t" } });
  expect(created.status).toBe(202);
  let uid: string | undefined;
  if (verified) {
    const verifiedResult = await call<SignedInBody>(action, "/api/auth/action", { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(await actionUrlOf(lastMail(sendMail, "verifyEmail", email)!)) } });
    expect(verifiedResult.status).toBe(200);
    uid = verifiedResult.body.session.uid;
  }
  return { email, uid };
}

beforeEach(() => resetRateLimiters());

describe("POST /api/auth/login", () => {
  it("signs a verified account in and the cookie works on /me", async () => {
    const { email, uid } = await createAccount(true);
    const jar = new Jar();
    const result = await call<SignedInBody>(login, LOGIN, { jar, body: { email: email.toUpperCase(), password: PASSWORD } });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("signed_in");
    expect(result.body.session.uid).toBe(uid);
    expect(result.body.session.role).toBe("individual");
    expect(result.header("x-csrf-token")).toBe(jar.get("__Host-csrf"));
    expect(jar.get("__Host-did")).toBeDefined();
    const who = await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar });
    expect(who.body.session?.uid).toBe(uid);
    expect(who.body.session?.emailVerified).toBe(true);
  });

  it("asks for verification first on a pending account, without opening a session", async () => {
    const { email } = await createAccount(false);
    const jar = new Jar();
    const result = await call<{ status: string }>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "verification_required" });
    expect(jar.get("__Host-session")).toBeUndefined();
  });

  it("escalates to Turnstile after 3 failures and locks the account + IP after 5", async () => {
    const { email } = await createAccount(true);
    const jar = new Jar();
    const wrong = { email, password: ["not", "the", "password", "1"].join("-") };
    for (let i = 0; i < 3; i += 1) {
      const failed = await call<ErrorBody>(login, LOGIN, { jar, body: wrong });
      expect(failed.status).toBe(401);
      expect(failed.body.error.code).toBe("invalid_credentials");
    }
    // 4th attempt without a token: the client must show the widget first.
    const challenge = await call<{ status: string }>(login, LOGIN, { jar, body: wrong });
    expect(challenge.status).toBe(200);
    expect(challenge.body).toEqual({ status: "turnstile_required" });
    // Right password without a token is not accepted either while the challenge stands.
    const blockedRight = await call<{ status: string }>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(blockedRight.body).toEqual({ status: "turnstile_required" });
    expect(jar.get("__Host-session")).toBeUndefined();

    const withToken = await call<ErrorBody>(login, LOGIN, { jar, body: { ...wrong, turnstileToken: "solved" } });
    expect(withToken.status).toBe(401);
    expect(vi.mocked(verifyTurnstile)).toHaveBeenLastCalledWith("solved", expect.objectContaining({ action: "login", hostname: "localhost" }));
    expect(jar.get("__Host-tsv")).toBeDefined();
    // The pass lifts the challenge for this device: no token needed on the 5th failure.
    const fifth = await call<ErrorBody>(login, LOGIN, { jar, body: wrong });
    expect(fifth.status).toBe(401);

    const locked = await call<ErrorBody>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("account_locked");
    // The lock runs for the full blockDuration from the 5th failure; Retry-After is what is left of it.
    const retryAfter = Number(locked.header("retry-after"));
    expect(retryAfter).toBeGreaterThan(RATE_LIMITS["login.fail.accountIp"].blockDuration - 10);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMITS["login.fail.accountIp"].blockDuration);

    // The lock is per account + IP: another network signs in normally.
    const elsewhere = await call<SignedInBody>(login, LOGIN, { jar: new Jar(), body: { email, password: PASSWORD } });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.status).toBe("signed_in");
  });

  it("counts the attempt before the password check: a burst past the allowance never reaches Firebase Auth (TOCTOU on the lock)", async () => {
    const { email } = await createAccount(true);
    const limit = RATE_LIMITS["login.fail.accountIp"].points;
    const ip = freshIp();
    const wrong = { email, password: ["not", "the", "password", "3"].join("-") };
    vi.mocked(signInWithPassword).mockClear();
    // Eight attempts at once, all reading "no failure yet": only `limit` of them may be checked.
    const burst = await Promise.all(Array.from({ length: limit + 3 }, () => call<ErrorBody>(login, LOGIN, { ip, body: wrong })));
    expect(burst.filter((result) => result.status === 401 && result.body.error.code === "invalid_credentials")).toHaveLength(limit);
    expect(burst.filter((result) => result.status === 429 && result.body.error.code === "account_locked")).toHaveLength(3);
    expect(vi.mocked(signInWithPassword)).toHaveBeenCalledTimes(limit);
    // The lock stands for the right password too.
    expect((await call<ErrorBody>(login, LOGIN, { ip, body: { email, password: PASSWORD } })).status).toBe(429);

    // Elsewhere, a right password forgets the attempts counted so far: no lock builds up on sign-ins.
    const other = freshIp();
    for (let i = 0; i < TURNSTILE_AFTER_FAILURES; i += 1) expect((await call(login, LOGIN, { ip: other, body: wrong })).status).toBe(401);
    expect((await call<SignedInBody>(login, LOGIN, { ip: other, body: { email, password: PASSWORD, turnstileToken: "solved" } })).status).toBe(200);
    // Counter back to zero: a failure is the first one again (no Turnstile), the right password signs in without a token.
    expect((await call(login, LOGIN, { ip: other, body: wrong })).status).toBe(401);
    expect((await call<SignedInBody>(login, LOGIN, { ip: other, body: { email, password: PASSWORD } })).status).toBe(200);
  });

  it("makes Turnstile mandatory after 20 failures per hour on the account, whatever the IP or the pass", async () => {
    const { email } = await createAccount(true);
    const wrong = { email, password: ["not", "the", "password", "2"].join("-") };
    const limit = RATE_LIMITS["login.fail.account"].points;
    // Spread over distinct IPs: no IP lock, no account + IP escalation.
    for (let i = 0; i < limit; i += 1) {
      const failed = await call<ErrorBody>(login, LOGIN, { jar: new Jar(), body: wrong });
      expect(failed.status).toBe(401);
    }
    const jar = new Jar();
    const challenge = await call<{ status: string }>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(challenge.status).toBe(200);
    expect(challenge.body).toEqual({ status: "turnstile_required" });
    // A solved challenge serves this request only: the 30-minute pass does not lift the account escalation.
    const failedWithToken = await call<ErrorBody>(login, LOGIN, { jar, body: { ...wrong, turnstileToken: "solved" } });
    expect(failedWithToken.status).toBe(401);
    expect(jar.get("__Host-tsv")).toBeDefined();
    const stillChallenged = await call<{ status: string }>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(stillChallenged.body).toEqual({ status: "turnstile_required" });
    const signedIn = await call<SignedInBody>(login, LOGIN, { jar, body: { email, password: PASSWORD, turnstileToken: "solved" } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.status).toBe("signed_in");
  });

  it("escalates an exhausted IP to Turnstile instead of a 429 (CGNAT: an IP is never blocked outright)", async () => {
    const { email } = await createAccount(true);
    const jar = new Jar();
    // The same key the handler consumes for this IP, exhausted in one go.
    const exhausted = await consumeLimit("login.ip", jar.ip, RATE_LIMITS["login.ip"].points);
    expect(exhausted).toEqual({ ok: true, remaining: 0 });
    const challenge = await call<{ status: string }>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(challenge.status).toBe(200);
    expect(challenge.body).toEqual({ status: "turnstile_required" });
    const signedIn = await call<SignedInBody>(login, LOGIN, { jar, body: { email, password: PASSWORD, turnstileToken: "solved" } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.status).toBe("signed_in");
    // The pass then lifts the IP escalation for this device.
    const again = await call<SignedInBody>(login, LOGIN, { jar, body: { email, password: PASSWORD } });
    expect(again.status).toBe(200);
  });

  it("fails closed when the lock counters cannot be read (policy closed, like the staff login)", async () => {
    vi.mocked(limitState).mockResolvedValueOnce(null);
    const result = await call<ErrorBody>(login, LOGIN, { jar: new Jar(), body: { email: uniqueEmail("store"), password: PASSWORD } });
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("unavailable");
  });

  it("answers invalid_credentials for an unknown e-mail, like a wrong password", async () => {
    const result = await call<ErrorBody>(login, LOGIN, { jar: new Jar(), body: { email: uniqueEmail("ghost"), password: PASSWORD } });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("invalid_credentials");
    const jar = new Jar();
    const { email } = await createAccount(true);
    for (let i = 0; i < 3; i += 1) await call(login, LOGIN, { jar, body: { email, password: ["wrong", "wrong", "1"].join("-") } });
    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, codes: ["invalid-input-response"] });
    const refused = await call<ErrorBody>(login, LOGIN, { jar, body: { email, password: PASSWORD, turnstileToken: "bad" } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("turnstile_failed");
  });

  it("refuses a disabled account and keeps staff accounts off the public host", async () => {
    const { email, uid } = await createAccount(true);
    await auth().updateUser(uid!, { disabled: true });
    const disabled = await call<ErrorBody>(login, LOGIN, { jar: new Jar(), body: { email, password: PASSWORD } });
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe("account_disabled");

    const staff = await createAccount(true, "Staff Member");
    await setClaims(staff.uid!, { role: "moderator" });
    const refused = await call<ErrorBody>(login, LOGIN, { jar: new Jar(), body: { email: staff.email, password: PASSWORD } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
  });
});
