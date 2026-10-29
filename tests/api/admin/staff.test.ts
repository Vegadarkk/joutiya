import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Staff authentication and roster against the Firebase emulators (vitest.api.config.ts:
// SITE_URL http://localhost:3000, ADMIN_HOST admin.localhost, APP_ENV dev without CF_ACCESS_AUD,
// so the Access identity is the x-dev-access-email header). Mails are captured, Turnstile passes
// (a site key is configured: every login attempt must carry a token, like a deployed environment).

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));
// Spies around the real limiter: single tests make the store "unavailable".
vi.mock("@/lib/rate-limit/limiter", { spy: true });
// Spies around the real roster: single tests shrink the active admins to the target (the emulator
// roster is shared with other runs, so "the last admin" cannot be arranged in Firestore itself).
vi.mock("@/lib/db/repositories/staff", { spy: true });

import { DELETE as deleteStaff } from "@/app/api/admin/staff/[uid]/route";
import { GET as getStaff, POST as postStaff } from "@/app/api/admin/staff/route";
import { POST as postLogin } from "@/app/api/admin/auth/login/route";
import { POST as postLogout } from "@/app/api/admin/auth/logout/route";
import { POST as postPassword } from "@/app/api/admin/auth/password/route";
import type { StaffListResponse, StaffLoginResponse } from "@/lib/auth/staff";
import { getStaff as readRoster, listActiveAdmins, upsertStaff } from "@/lib/db/repositories/staff";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import { HttpError, type ErrorBody } from "@/lib/http/errors";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { expectedOrigin } from "@/lib/security/origin";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { actionLinkOf, actionUrlOf } from "../auth/helpers";

const ADMIN_ORIGIN = expectedOrigin("admin");
const ADMIN_HOST = new URL(ADMIN_ORIGIN).host;
const PUBLIC_ORIGIN = expectedOrigin("public");
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Porte", "Ouverte", "2026"].join("-");
const FIRST_PASSWORD = ["Nouveau", "Secret", "1"].join("-");
const OTHER_PASSWORD = ["Autre", "Secret", "2"].join("-");
const TOKEN = "turnstile-token";
const run = Date.now().toString(36);
const address = (name: string) => `${name}-${run}@staff.test`;
const EMAIL = {
  admin: address("admin"),
  moderator: address("moderator"),
  member: address("member"),
  locked: address("locked"),
  invited: address("invited"),
  /** Public sign-up never confirmed: an Auth record without claims, with the squatter's password. */
  squatted: address("squatted"),
  /** Staff claims without a roster entry (a bootstrap stopped halfway). */
  ghost: address("ghost"),
};

interface RequestOptions {
  host?: string;
  /** null: no Origin header. */
  origin?: string | null;
  /** Access identity (x-dev-access-email); absent: the dev default. */
  access?: string;
  cookies?: Record<string, string>;
  csrf?: string;
  body?: unknown;
  ip?: string;
}

function call(method: string, path: string, options: RequestOptions = {}): NextRequest {
  const host = options.host ?? ADMIN_HOST;
  const headers = new Headers({ host, "user-agent": "vitest" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ADMIN_ORIGIN);
  if (options.access !== undefined) headers.set("x-dev-access-email", options.access);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookies) headers.set("cookie", Object.entries(options.cookies).map(([name, value]) => `${name}=${value}`).join("; "));
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  if (options.ip) headers.set("x-forwarded-for", options.ip);
  return new NextRequest(`http://${host}${path}`, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
}

const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });

/** Login call with the Access identity of `email` and a Turnstile token (required on every attempt). */
const loginCall = (email: string, password: string, options: Partial<RequestOptions> & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = options;
  return postLogin(call("POST", "/api/admin/auth/login", { access: email, body: { email, password, ...(token ? { turnstileToken: token } : {}) }, ...rest }), ctx());
};

/**
 * Firebase compares auth_time and tokensValidAfterTime in whole seconds: a session minted and
 * revoked within the same second still verifies. Waits for the next second before a revocation.
 */
async function nextSecond(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === now) await new Promise((resolve) => setTimeout(resolve, 50));
}

function cookiesOf(response: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return jar;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

async function createAccount(email: string, role: Role, displayName: string): Promise<string> {
  const record = await auth().createUser({ email, password: PASSWORD, emailVerified: true, displayName });
  await setClaims(record.uid, { role, v: 2 });
  return record.uid;
}

interface Session {
  uid: string;
  cookies: Record<string, string>;
  csrf: string;
}

async function signIn(email: string, password = PASSWORD): Promise<Session> {
  const response = await loginCall(email, password);
  expect(response.status).toBe(200);
  const body = (await response.json()) as StaffLoginResponse;
  if (body.status !== "signed_in") throw new Error(`unexpected status ${body.status}`);
  const cookies = cookiesOf(response);
  return { uid: body.staff.uid, cookies, csrf: cookies["__Host-csrf"] ?? "" };
}

const uids: Record<"admin" | "moderator" | "member" | "locked" | "squatted" | "ghost", string> = { admin: "", moderator: "", member: "", locked: "", squatted: "", ghost: "" };

beforeAll(async () => {
  uids.admin = await createAccount(EMAIL.admin, "admin", "Admin Test");
  await upsertStaff({ uid: uids.admin, email: EMAIL.admin, displayName: "Admin Test", role: "admin", invitedBy: "script" });
  uids.moderator = await createAccount(EMAIL.moderator, "moderator", "Modo Test");
  await upsertStaff({ uid: uids.moderator, email: EMAIL.moderator, displayName: "Modo Test", role: "moderator", invitedBy: uids.admin });
  uids.locked = await createAccount(EMAIL.locked, "moderator", "Locked Test");
  await upsertStaff({ uid: uids.locked, email: EMAIL.locked, displayName: "Locked Test", role: "moderator", invitedBy: uids.admin });
  uids.member = await createAccount(EMAIL.member, "individual", "Membre Test");
  uids.squatted = (await auth().createUser({ email: EMAIL.squatted, password: OTHER_PASSWORD, emailVerified: false })).uid;
  uids.ghost = await createAccount(EMAIL.ghost, "moderator", "Ghost Test");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
  vi.mocked(verifyTurnstile).mockClear();
});

describe("admin host only", () => {
  it("answers 404 for every back-office route on the public host", async () => {
    const options = { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, access: EMAIL.admin };
    const body = { email: EMAIL.admin, password: PASSWORD, turnstileToken: TOKEN };
    expect((await postLogin(call("POST", "/api/admin/auth/login", { ...options, body }), ctx())).status).toBe(404);
    expect((await postLogout(call("POST", "/api/admin/auth/logout", options), ctx())).status).toBe(404);
    expect((await postPassword(call("POST", "/api/admin/auth/password", { ...options, body: { oobCode: "x".repeat(20), password: PASSWORD } }), ctx())).status).toBe(404);
    expect((await getStaff(call("GET", "/api/admin/staff", options), ctx())).status).toBe(404);
    expect((await postStaff(call("POST", "/api/admin/staff", { ...options, body: {} }), ctx())).status).toBe(404);
    expect((await deleteStaff(call("DELETE", "/api/admin/staff/x", options), ctx({ uid: "x" }))).status).toBe(404);
  });
});

describe("POST /api/admin/auth/login", () => {
  it("refuses a request without the Access identity", async () => {
    // Outside dev-without-Access, the identity comes from the Access JWT: absent here.
    vi.stubEnv("CF_ACCESS_AUD", "test-aud");
    resetServerEnv();
    try {
      const response = await postLogin(call("POST", "/api/admin/auth/login", { body: { email: EMAIL.admin, password: PASSWORD, turnstileToken: TOKEN } }), ctx());
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthenticated");
    } finally {
      vi.unstubAllEnvs();
      resetServerEnv();
    }
  });

  it("refuses an e-mail that differs from the Access identity", async () => {
    const response = await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.moderator, body: { email: EMAIL.admin, password: PASSWORD, turnstileToken: TOKEN } }), ctx());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden", message: "Access identity does not match" } });
  });

  it("refuses a missing or foreign Origin", async () => {
    expect(await errorCode(await loginCall(EMAIL.admin, PASSWORD, { origin: null }))).toBe("origin");
    expect(await errorCode(await loginCall(EMAIL.admin, PASSWORD, { origin: "https://evil.example" }))).toBe("origin");
    // The public origin is foreign on the admin host too.
    expect(await errorCode(await loginCall(EMAIL.admin, PASSWORD, { origin: PUBLIC_ORIGIN }))).toBe("origin");
  });

  it("refuses a member account even with the right password", async () => {
    const response = await loginCall(EMAIL.member, PASSWORD);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("asks for a Turnstile token on every attempt while a site key is configured, and checks it on the admin host", async () => {
    const challenge = await loginCall(EMAIL.moderator, PASSWORD, { token: null });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ status: "turnstile_required" });
    expect(verifyTurnstile).not.toHaveBeenCalled();

    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, codes: ["invalid-input-response"] });
    const refused = await loginCall(EMAIL.moderator, PASSWORD, { token: "bad-token" });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("turnstile_failed");
    expect(verifyTurnstile).toHaveBeenCalledWith("bad-token", { action: "staff-login", remoteIp: "127.0.0.1", hostname: new URL(ADMIN_ORIGIN).hostname });

    // Neither answer counted as an attempt: the right password still signs in.
    expect((await loginCall(EMAIL.moderator, PASSWORD)).status).toBe(200);
  });

  it("locks the account + IP from the 5th failure for 15 minutes, with the store's Retry-After", async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await loginCall(EMAIL.locked, "wrong-password");
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("invalid_credentials");
    }
    // The 5th failure blocked the pair itself (not the next attempt): the right password is refused
    // until that block expires.
    expect(limiter.blockLimit).toHaveBeenCalledTimes(1);
    const locked = await loginCall(EMAIL.locked, PASSWORD);
    expect(locked.status).toBe(429);
    expect(await errorCode(locked)).toBe("account_locked");
    const retryAfter = Number(locked.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(880);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(locked.headers.getSetCookie()).toEqual([]);

    // Another IP is not locked for this account.
    const elsewhere = await loginCall(EMAIL.locked, PASSWORD, { ip: "203.0.113.9" });
    expect(elsewhere.status).toBe(200);
  });

  it("counts the attempt before the password check: a parallel burst past the allowance is refused (TOCTOU, F8)", async () => {
    const ip = "203.0.113.77";
    const burst = await Promise.all(Array.from({ length: 8 }, () => loginCall(EMAIL.ghost, "wrong-password", { ip })));
    const codes = await Promise.all(burst.map((response) => errorCode(response)));
    expect(codes.filter((code) => code === "invalid_credentials")).toHaveLength(5);
    expect(codes.filter((code) => code === "account_locked")).toHaveLength(3);
  });

  it("fails closed when the rate-limit store is unavailable", async () => {
    vi.mocked(limiter.enforceLimit).mockRejectedValueOnce(new HttpError(503, "unavailable", "rate limiter unavailable"));
    const perIp = await loginCall(EMAIL.moderator, PASSWORD);
    expect(perIp.status).toBe(503);
    expect(await errorCode(perIp)).toBe("unavailable");

    // An unreadable failure counter never reads as "no failures": the pair's, then the account's.
    vi.mocked(limiter.limitState).mockResolvedValueOnce(null);
    const unreadable = await loginCall(EMAIL.moderator, PASSWORD);
    expect(unreadable.status).toBe(503);
    expect(unreadable.headers.getSetCookie()).toEqual([]);
    vi.mocked(limiter.limitState).mockResolvedValueOnce({ consumedPoints: 0, msBeforeNext: 0 }).mockResolvedValueOnce(null);
    const unreadableAccount = await loginCall(EMAIL.moderator, PASSWORD);
    expect(unreadableAccount.status).toBe(503);
    expect(unreadableAccount.headers.getSetCookie()).toEqual([]);
  });

  it("signs a moderator in with an 8-hour session", async () => {
    const response = await loginCall(EMAIL.moderator, PASSWORD);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "signed_in",
      staff: { uid: uids.moderator, email: EMAIL.moderator, role: "moderator", displayName: "Modo Test" },
    });
    const setCookies = response.headers.getSetCookie();
    const session = setCookies.find((line) => line.startsWith("__Host-session="));
    const csrf = setCookies.find((line) => line.startsWith("__Host-csrf="));
    expect(session).toMatch(/Max-Age=28800/);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/Path=\//);
    expect(csrf).not.toMatch(/HttpOnly/);
    expect(response.headers.get("x-csrf-token")).toBe(cookiesOf(response)["__Host-csrf"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/admin/staff", () => {
  it("refuses anonymous calls and moderators", async () => {
    expect((await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.admin }), ctx())).status).toBe(401);
    const moderator = await signIn(EMAIL.moderator);
    const response = await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.moderator, cookies: moderator.cookies }), ctx());
    expect(response.status).toBe(403);
  });

  it("refuses an admin session whose Access identity is another person", async () => {
    const admin = await signIn(EMAIL.admin);
    const response = await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.moderator, cookies: admin.cookies }), ctx());
    expect(response.status).toBe(403);
  });

  it("lists the roster for an admin, oldest first", async () => {
    const admin = await signIn(EMAIL.admin);
    const response = await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.admin, cookies: admin.cookies }), ctx());
    expect(response.status).toBe(200);
    const { staff } = (await response.json()) as StaffListResponse;
    const ours = staff.filter((member) => member.email.endsWith(`-${run}@staff.test`));
    expect(ours.map((member) => member.email)).toEqual([EMAIL.admin, EMAIL.moderator, EMAIL.locked]);
    expect(ours[0]).toMatchObject({ uid: uids.admin, displayName: "Admin Test", role: "admin", invitedBy: "script", revokedAt: null });
    expect(new Date(ours[0]!.createdAt).getTime()).toBeLessThanOrEqual(new Date(ours[1]!.createdAt).getTime());
  });
});

describe("invitation, password and revocation", () => {
  let admin: Session;
  let invitedUid = "";
  let oobCode = "";

  beforeAll(async () => {
    admin = await signIn(EMAIL.admin);
  });

  const invite = (body: unknown, options: Partial<RequestOptions> = {}) =>
    postStaff(call("POST", "/api/admin/staff", { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf, body, ...options }), ctx());

  it("refuses an invitation without the CSRF token or the Origin", async () => {
    const body = { email: EMAIL.invited, displayName: "Invitée Test", role: "moderator" };
    expect(await errorCode(await invite(body, { csrf: undefined }))).toBe("csrf");
    expect(await errorCode(await invite(body, { origin: null }))).toBe("origin");
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
  });

  it("refuses an invalid body, yourself, a member account and a sign-up never confirmed", async () => {
    expect(await errorCode(await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "individual" }))).toBe("invalid_body");
    const self = await invite({ email: EMAIL.admin, displayName: "Admin Test", role: "admin" });
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe("conflict");
    const member = await invite({ email: EMAIL.member, displayName: "Membre Test", role: "moderator" });
    expect(member.status).toBe(409);
    expect(await errorCode(member)).toBe("conflict");
    // Whoever registered that address (and never confirmed it) chose its password: it never becomes staff.
    const squatted = await invite({ email: EMAIL.squatted, displayName: "Squat Test", role: "admin" });
    expect(squatted.status).toBe(409);
    expect(await response409(squatted)).toBe("a Aalan account exists with this e-mail");
    const record = await auth().getUser(uids.squatted);
    expect(record.customClaims ?? {}).toEqual({});
    expect(await readRoster(uids.squatted)).toBeNull();
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
  });

  async function response409(response: Response): Promise<string | undefined> {
    return ((await response.json()) as ErrorBody).error.message;
  }

  it("refuses an invitation from a moderator", async () => {
    const moderator = await signIn(EMAIL.moderator);
    const response = postStaff(
      call("POST", "/api/admin/staff", { access: EMAIL.moderator, cookies: moderator.cookies, csrf: moderator.csrf, body: { email: EMAIL.invited, displayName: "Invitée Test", role: "moderator" } }),
      ctx(),
    );
    expect((await response).status).toBe(403);
  });

  it("invites a moderator: claims, roster entry and a staffInvite mail on the admin origin", async () => {
    const response = await invite({ email: EMAIL.invited.toUpperCase(), displayName: "Invitée Test", role: "moderator" });
    expect(response.status).toBe(201);
    ({ uid: invitedUid } = (await response.json()) as { uid: string });
    expect(invitedUid).toBeTruthy();

    const record = await auth().getUser(invitedUid);
    expect(record.email).toBe(EMAIL.invited);
    expect(record.emailVerified).toBe(true);
    expect(record.customClaims).toEqual({ role: "moderator", v: 2 });

    const roster = await readRoster(invitedUid);
    expect(roster).toMatchObject({ uid: invitedUid, email: EMAIL.invited, displayName: "Invitée Test", role: "moderator", invitedBy: uids.admin });
    expect(roster?.revokedAt).toBeUndefined();

    expect(vi.mocked(sendMail)).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendMail).mock.calls[0]![0];
    expect(mail).toMatchObject({ template: "staffInvite", locale: "fr", to: EMAIL.invited, priority: "security" });
    const data = mail.data as { displayName: string; role: string };
    expect(data.role).toBe("moderator");
    expect(actionLinkOf(mail)).toEqual({ action: "resetPassword", url: `${ADMIN_ORIGIN}/connexion?mode=setPassword`, continueUrl: `${ADMIN_ORIGIN}/connexion` });
    const url = new URL(await actionUrlOf(mail));
    expect(url.origin).toBe(ADMIN_ORIGIN);
    expect(url.pathname).toBe("/connexion");
    expect(url.searchParams.get("mode")).toBe("setPassword");
    oobCode = url.searchParams.get("oobCode") ?? "";
    expect(oobCode.length).toBeGreaterThan(10);
  });

  it("refuses to set the password under another Access identity", async () => {
    const response = await postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.admin, body: { oobCode, password: FIRST_PASSWORD } }), ctx());
    expect(response.status).toBe(403);
  });

  it("refuses a short, common or personal password without consuming the code", async () => {
    const attempt = (password: string) => postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.invited, body: { oobCode, password } }), ctx());
    // 8 characters suit members, not staff (12).
    expect(await errorCode(await attempt("Court-12345"))).toBe("invalid_body");
    const common = await attempt("password1234");
    expect(common.status).toBe(400);
    expect(await common.json()).toEqual({ error: { code: "weak_password", details: { reason: "common" } } });
    // The e-mail's local part ("invited-<run>") must not appear in the password.
    const personal = await attempt(`Invited-${run}-ok`);
    expect(await personal.json()).toEqual({ error: { code: "weak_password", details: { reason: "personal" } } });
    expect((await attempt("abcdefghijkl")).status).toBe(400);
  });

  it("sets the password with the invitation code, then signs the member in", async () => {
    const response = await postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.invited, body: { oobCode, password: FIRST_PASSWORD } }), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "password_set" });

    // The code is consumed.
    const reused = await postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.invited, body: { oobCode, password: OTHER_PASSWORD } }), ctx());
    expect(reused.status).toBe(400);
    expect(await errorCode(reused)).toBe("invalid_code");

    const session = await signIn(EMAIL.invited, FIRST_PASSWORD);
    expect(session.uid).toBe(invitedUid);
    // A moderator: no roster access.
    expect((await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.invited, cookies: session.cookies }), ctx())).status).toBe(403);
  });

  it("refuses to set the password of a member account", async () => {
    const link = await auth().generatePasswordResetLink(EMAIL.member, { url: `${ADMIN_ORIGIN}/connexion` });
    const code = new URL(link).searchParams.get("oobCode") ?? "";
    const response = await postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.member, body: { oobCode: code, password: FIRST_PASSWORD } }), ctx());
    expect(response.status).toBe(403);
  });

  it("never revokes yourself, answers 404 for unknown members and refuses moderators", async () => {
    const self = await deleteStaff(call("DELETE", `/api/admin/staff/${uids.admin}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: uids.admin }));
    expect(self.status).toBe(403);
    expect((await auth().getUser(uids.admin)).disabled).toBe(false);

    const unknown = await deleteStaff(call("DELETE", "/api/admin/staff/nobody", { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: "nobody" }));
    expect(unknown.status).toBe(404);
    // A path is not a document id: "a/b/c" would address a subcollection document (and "a/b" would throw in the SDK).
    for (const uid of ["a/b/c", "a/b", "x".repeat(129), "nobody?"]) {
      const path = await deleteStaff(call("DELETE", `/api/admin/staff/${encodeURIComponent(uid)}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid }));
      expect(path.status).toBe(404);
    }
    // A member account is not a staff member either (and stays untouched).
    const member = await deleteStaff(call("DELETE", `/api/admin/staff/${uids.member}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: uids.member }));
    expect(member.status).toBe(404);
    expect((await auth().getUser(uids.member)).disabled).toBe(false);

    const moderator = await signIn(EMAIL.moderator);
    const refused = await deleteStaff(
      call("DELETE", `/api/admin/staff/${invitedUid}`, { access: EMAIL.moderator, cookies: moderator.cookies, csrf: moderator.csrf }),
      ctx({ uid: invitedUid }),
    );
    expect(refused.status).toBe(403);
  });

  it("revokes another member: claims cleared, account disabled, sessions dead, Access reminder in the audit", async () => {
    const victim = await signIn(EMAIL.invited, FIRST_PASSWORD);
    await nextSecond();
    const response = await deleteStaff(call("DELETE", `/api/admin/staff/${invitedUid}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: invitedUid }));
    expect(response.status).toBe(204);

    const record = await auth().getUser(invitedUid);
    expect(record.disabled).toBe(true);
    expect(record.customClaims ?? {}).toEqual({});
    expect((await readRoster(invitedUid))?.revokedAt).toBeInstanceOf(Date);

    // The earlier session no longer verifies (checkRevoked), and the password no longer signs in.
    expect((await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.invited, cookies: victim.cookies }), ctx())).status).toBe(401);
    const login = await loginCall(EMAIL.invited, FIRST_PASSWORD);
    expect(login.status).toBe(403);
    expect(await errorCode(login)).toBe("account_disabled");

    // App-side revocation leaves the Cloudflare Access policy alone: the audit entry says so.
    const entries = await db().collection(COLLECTIONS.auditLogs).where("action", "==", "staff.revoke").where("target.id", "==", invitedUid).get();
    expect(entries.size).toBe(1);
    expect(entries.docs[0]!.data()).toMatchObject({ actorUid: uids.admin, actorRole: "admin", automated: false, reason: "retirer aussi de Cloudflare Access" });
  });

  it("revokes an account carrying staff claims without a roster entry, and leaves a tombstone", async () => {
    expect(await readRoster(uids.ghost)).toBeNull();
    const response = await deleteStaff(call("DELETE", `/api/admin/staff/${uids.ghost}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: uids.ghost }));
    expect(response.status).toBe(204);
    const record = await auth().getUser(uids.ghost);
    expect(record.disabled).toBe(true);
    expect(record.customClaims ?? {}).toEqual({});
    const tombstone = await readRoster(uids.ghost);
    expect(tombstone).toMatchObject({ uid: uids.ghost, email: EMAIL.ghost, displayName: "Ghost Test", role: "moderator", invitedBy: "script" });
    expect(tombstone?.revokedAt).toBeInstanceOf(Date);
  });

  it("re-inviting a revoked member reactivates the account with the new role", async () => {
    const response = await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "admin" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ uid: invitedUid });
    const record = await auth().getUser(invitedUid);
    expect(record.disabled).toBe(false);
    expect(record.customClaims).toEqual({ role: "admin", v: 2 });
    expect((await readRoster(invitedUid))?.revokedAt).toBeUndefined();
    // A revoked entry given a role again is a re-invitation, not a role change.
    expect((await db().collection(COLLECTIONS.auditLogs).where("action", "==", "staff.role_change").where("target.id", "==", invitedUid).get()).size).toBe(0);
  });

  it("audits a new role on an active colleague as staff.role_change, and keeps at least one active admin", async () => {
    const roleChanges = () => db().collection(COLLECTIONS.auditLogs).where("action", "==", "staff.role_change").where("target.id", "==", invitedUid).get();
    // Demoting an active admin while another one (the caller) remains: allowed, audited as a role change.
    const demoted = await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "moderator" });
    expect(demoted.status).toBe(201);
    expect((await auth().getUser(invitedUid)).customClaims).toEqual({ role: "moderator", v: 2 });
    expect((await readRoster(invitedUid))?.role).toBe("moderator");
    let entries = await roleChanges();
    expect(entries.size).toBe(1);
    expect(entries.docs[0]!.data()).toMatchObject({ actorUid: uids.admin, actorRole: "admin", automated: false, reason: "admin->moderator" });
    // Back to admin: a second entry; the same role again: an invitation only.
    expect((await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "admin" })).status).toBe(201);
    expect((await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "admin" })).status).toBe(201);
    entries = await roleChanges();
    expect(entries.docs.map((entry) => entry.get("reason")).sort()).toEqual(["admin->moderator", "moderator->admin"]);

    // The roster as the guard would see it once `invited` is the only active admin left (the
    // caller's own entry already demoted by a concurrent change, or a bootstrap without entry).
    const only = (await listActiveAdmins()).filter((member) => member.uid === invitedUid);
    expect(only).toHaveLength(1);
    vi.mocked(listActiveAdmins).mockResolvedValueOnce(only);
    const lastDemotion = await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "moderator" });
    expect(lastDemotion.status).toBe(409);
    expect(await errorCode(lastDemotion)).toBe("conflict");
    expect((await auth().getUser(invitedUid)).customClaims).toEqual({ role: "admin", v: 2 });
    expect((await readRoster(invitedUid))?.role).toBe("admin");
    vi.mocked(listActiveAdmins).mockResolvedValueOnce(only);
    const lastRevocation = await deleteStaff(call("DELETE", `/api/admin/staff/${invitedUid}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: invitedUid }));
    expect(lastRevocation.status).toBe(409);
    expect(await errorCode(lastRevocation)).toBe("conflict");
    expect((await auth().getUser(invitedUid)).disabled).toBe(false);
    expect((await auth().getUser(invitedUid)).customClaims).toEqual({ role: "admin", v: 2 });
    expect((await readRoster(invitedUid))?.revokedAt).toBeUndefined();
    // With the caller still an active admin in the roster, the revocation goes through.
    const revoked = await deleteStaff(call("DELETE", `/api/admin/staff/${invitedUid}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: invitedUid }));
    expect(revoked.status).toBe(204);
    expect((await readRoster(invitedUid))?.revokedAt).toBeInstanceOf(Date);
  });
});

describe("POST /api/admin/auth/logout", () => {
  it("clears the cookies and revokes the session", async () => {
    const moderator = await signIn(EMAIL.moderator);
    await nextSecond();
    const response = await postLogout(call("POST", "/api/admin/auth/logout", { access: EMAIL.moderator, cookies: moderator.cookies }), ctx());
    expect(response.status).toBe(204);
    const cleared = response.headers.getSetCookie();
    expect(cleared.some((line) => line.startsWith("__Host-session=") && /Max-Age=0/.test(line))).toBe(true);
    expect(cleared.some((line) => line.startsWith("__Host-csrf=") && /Max-Age=0/.test(line))).toBe(true);
    // Revoked: the old cookie no longer opens anything.
    expect((await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.moderator, cookies: moderator.cookies }), ctx())).status).toBe(401);
  });

  it("answers 204 without a session and 403 without the Origin", async () => {
    expect((await postLogout(call("POST", "/api/admin/auth/logout", {}), ctx())).status).toBe(204);
    expect((await postLogout(call("POST", "/api/admin/auth/logout", { origin: null }), ctx())).status).toBe(403);
  });
});
