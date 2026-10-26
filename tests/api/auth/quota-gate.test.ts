import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGoogleVerifierForTests, type GoogleIdentity } from "@/lib/auth/google";
import { findUidByEmail } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import type * as Quota from "@/lib/quota";
import { firstDegraded } from "@/lib/quota";
import { QUOTA_ERROR_CODE } from "@/lib/quota/gate";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { DEVICE_COOKIE } from "@/lib/security/cookies";
import { gisNonce, newDeviceCookie } from "@/lib/security/device";
import type * as Turnstile from "@/lib/security/turnstile";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { POST as google } from "@/app/api/auth/google/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { CONSENTS, Jar, PASSWORD, call, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

// Degraded Firestore writes (§2 "Garde-fous de quotas"): a new account would fail after its Auth
// record, so sign-up answers 503 with a Retry-After up front; existing members still sign in.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));

const SIGNUP = "/api/auth/signup";
const GOOGLE = "/api/auth/google";
/** Google calls come from one device: its cookie is in the jar and its GIS nonce in the credential. */
const DEVICE = newDeviceCookie();

function googleJar(): Jar {
  const jar = new Jar();
  jar.cookies.set(DEVICE_COOKIE, DEVICE.value);
  return jar;
}

function googleBody(email: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { credential: JSON.stringify({ sub: `g-${email}`, email, emailVerified: true, name: "Nadia Google", nonce: gisNonce(DEVICE.id) }), ...extra };
}

async function authRecord(email: string) {
  return auth()
    .getUserByEmail(email)
    .catch(() => null);
}

beforeAll(() => setGoogleVerifierForTests(async (value) => JSON.parse(value) as GoogleIdentity));
beforeEach(() => {
  resetRateLimiters();
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
  vi.mocked(verifyTurnstile).mockClear();
});

describe("sign-up with degraded Firestore writes", () => {
  it("refuses an e-mail sign-up before Turnstile and the Auth record", async () => {
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    const email = uniqueEmail("qs");
    const refused = await call<ErrorBody>(signup, SIGNUP, {
      jar: new Jar(),
      body: { email, password: PASSWORD, displayName: "Yasmine Test", locale: "fr", consents: CONSENTS, turnstileToken: "t" },
    });
    expect([refused.status, refused.body.error.code]).toEqual([503, QUOTA_ERROR_CODE]);
    expect(Number(refused.header("retry-after"))).toBeGreaterThanOrEqual(60);
    expect(refused.header("cache-control")).toBe("no-store");
    expect(firstDegraded).toHaveBeenCalledWith(["firestore.writes"]);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(await authRecord(email)).toBeNull();
    expect(await findUidByEmail(email)).toBeNull();

    // Back to normal: the same address signs up.
    vi.mocked(firstDegraded).mockResolvedValue(null);
    const accepted = await call(signup, SIGNUP, {
      jar: new Jar(),
      body: { email, password: PASSWORD, displayName: "Yasmine Test", locale: "fr", consents: CONSENTS, turnstileToken: "t" },
    });
    expect(accepted.status).toBe(202);
    expect(await findUidByEmail(email)).not.toBeNull();
  });

  it("does not use up the device's sign-up allowance (3 a day) on refusals: the retry after the reset goes through", async () => {
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    const jar = new Jar();
    const body = { email: uniqueEmail("qd"), password: PASSWORD, displayName: "Yasmine Test", locale: "fr", consents: CONSENTS, turnstileToken: "t" };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const refused = await call<ErrorBody>(signup, SIGNUP, { jar, body });
      expect([refused.status, refused.body.error.code], `attempt ${attempt}`).toEqual([503, QUOTA_ERROR_CODE]);
    }
    vi.mocked(firstDegraded).mockResolvedValue(null);
    const accepted = await call(signup, SIGNUP, { jar, body });
    expect(accepted.status).toBe(202);
  });

  it("does not use up the device's sign-up allowance on refused Google consent passes either", async () => {
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    const jar = googleJar();
    const email = uniqueEmail("qe");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const refused = await call<ErrorBody>(google, GOOGLE, { jar, body: googleBody(email) });
      expect([refused.status, refused.body.error.code], `attempt ${attempt}`).toEqual([503, QUOTA_ERROR_CODE]);
    }
    vi.mocked(firstDegraded).mockResolvedValue(null);
    const created = await call<SignedInBody>(google, GOOGLE, { jar, body: googleBody(email, { consents: CONSENTS, turnstileToken: "t", locale: "fr" }) });
    expect(created.body.status).toBe("signed_in");
  });

  it("refuses a new Google account before the consent step, and still signs a member in", async () => {
    const member = uniqueEmail("qg");
    const created = await call<SignedInBody>(google, GOOGLE, { jar: googleJar(), body: googleBody(member, { consents: CONSENTS, turnstileToken: "t", locale: "fr" }) });
    expect(created.body.status).toBe("signed_in");

    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    const newcomer = uniqueEmail("qn");
    const consent = await call<ErrorBody>(google, GOOGLE, { jar: googleJar(), body: googleBody(newcomer) });
    expect([consent.status, consent.body.error.code]).toEqual([503, QUOTA_ERROR_CODE]);
    const withConsents = await call<ErrorBody>(google, GOOGLE, { jar: googleJar(), body: googleBody(newcomer, { consents: CONSENTS, turnstileToken: "t", locale: "fr" }) });
    expect([withConsents.status, withConsents.body.error.code]).toEqual([503, QUOTA_ERROR_CODE]);
    expect(await authRecord(newcomer)).toBeNull();

    const again = await call<SignedInBody>(google, GOOGLE, { jar: googleJar(), body: googleBody(member) });
    expect(again.status).toBe(200);
    expect(again.body.session.uid).toBe(created.body.session.uid);
  });
});
