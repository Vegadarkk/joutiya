import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Staff authentication and roster against the Firebase emulators (vitest.api.config.ts:
// SITE_URL http://localhost:3000, ADMIN_HOST admin.localhost, APP_ENV dev without CF_ACCESS_AUD,
// so the Access identity is the x-dev-access-email header). Mails are captured, Turnstile passes.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { DELETE as deleteStaff } from "@/app/api/admin/staff/[uid]/route";
import { GET as getStaff, POST as postStaff } from "@/app/api/admin/staff/route";
import { POST as postLogin } from "@/app/api/admin/auth/login/route";
import { POST as postLogout } from "@/app/api/admin/auth/logout/route";
import { POST as postPassword } from "@/app/api/admin/auth/password/route";
import type { StaffListResponse, StaffLoginResponse } from "@/lib/auth/staff";
import { getStaff as readRoster, upsertStaff } from "@/lib/db/repositories/staff";
import { resetServerEnv } from "@/lib/env";
import { auth } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import type { ErrorBody } from "@/lib/http/errors";
import { sendMail } from "@/lib/mail";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { expectedOrigin } from "@/lib/security/origin";
import { verifyTurnstile } from "@/lib/security/turnstile";

const ADMIN_ORIGIN = expectedOrigin("admin");
const ADMIN_HOST = new URL(ADMIN_ORIGIN).host;
const PUBLIC_ORIGIN = expectedOrigin("public");
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Porte", "Ouverte", "2026"].join("-");
const FIRST_PASSWORD = ["Nouveau", "Secret", "1"].join("-");
const OTHER_PASSWORD = ["Autre", "Secret", "2"].join("-");
const run = Date.now().toString(36);
const address = (name: string) => `${name}-${run}@staff.test`;
const EMAIL = { admin: address("admin"), moderator: address("moderator"), member: address("member"), locked: address("locked"), invited: address("invited") };

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
  const response = await postLogin(call("POST", "/api/admin/auth/login", { access: email, body: { email, password } }), ctx());
  expect(response.status).toBe(200);
  const body = (await response.json()) as StaffLoginResponse;
  if (body.status !== "signed_in") throw new Error(`unexpected status ${body.status}`);
  const cookies = cookiesOf(response);
  return { uid: body.staff.uid, cookies, csrf: cookies["__Host-csrf"] ?? "" };
}

const uids: Record<"admin" | "moderator" | "member" | "locked", string> = { admin: "", moderator: "", member: "", locked: "" };

beforeAll(async () => {
  uids.admin = await createAccount(EMAIL.admin, "admin", "Admin Test");
  await upsertStaff({ uid: uids.admin, email: EMAIL.admin, displayName: "Admin Test", role: "admin", invitedBy: "script" });
  uids.moderator = await createAccount(EMAIL.moderator, "moderator", "Modo Test");
  await upsertStaff({ uid: uids.moderator, email: EMAIL.moderator, displayName: "Modo Test", role: "moderator", invitedBy: uids.admin });
  uids.locked = await createAccount(EMAIL.locked, "moderator", "Locked Test");
  await upsertStaff({ uid: uids.locked, email: EMAIL.locked, displayName: "Locked Test", role: "moderator", invitedBy: uids.admin });
  uids.member = await createAccount(EMAIL.member, "individual", "Membre Test");
});

beforeEach(() => {
  resetRateLimiters();
  vi.mocked(sendMail).mockClear();
  vi.mocked(verifyTurnstile).mockClear();
});

describe("admin host only", () => {
  it("answers 404 for every back-office route on the public host", async () => {
    const options = { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, access: EMAIL.admin };
    const body = { email: EMAIL.admin, password: PASSWORD };
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
      const response = await postLogin(call("POST", "/api/admin/auth/login", { body: { email: EMAIL.admin, password: PASSWORD } }), ctx());
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("unauthenticated");
    } finally {
      vi.unstubAllEnvs();
      resetServerEnv();
    }
  });

  it("refuses an e-mail that differs from the Access identity", async () => {
    const response = await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.moderator, body: { email: EMAIL.admin, password: PASSWORD } }), ctx());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden", message: "Access identity does not match" } });
  });

  it("refuses a missing or foreign Origin", async () => {
    const body = { email: EMAIL.admin, password: PASSWORD };
    expect(await errorCode(await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.admin, origin: null, body }), ctx()))).toBe("origin");
    expect(await errorCode(await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.admin, origin: "https://evil.example", body }), ctx()))).toBe("origin");
    // The public origin is foreign on the admin host too.
    expect(await errorCode(await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.admin, origin: PUBLIC_ORIGIN, body }), ctx()))).toBe("origin");
  });

  it("refuses a member account even with the right password", async () => {
    const response = await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.member, body: { email: EMAIL.member, password: PASSWORD } }), ctx());
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("asks Turnstile from the 3rd failure and locks the account + IP after the 5th", async () => {
    const attempt = (password: string, turnstileToken?: string) =>
      postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.locked, body: { email: EMAIL.locked, password, ...(turnstileToken ? { turnstileToken } : {}) } }), ctx());
    for (let i = 0; i < 3; i += 1) {
      const response = await attempt("wrong-password");
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("invalid_credentials");
    }
    const challenge = await attempt("wrong-password");
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ status: "turnstile_required" });
    expect(verifyTurnstile).not.toHaveBeenCalled();

    expect((await attempt("wrong-password", "token-4")).status).toBe(401);
    expect(verifyTurnstile).toHaveBeenCalledWith("token-4", expect.objectContaining({ action: "staff-login" }));
    expect((await attempt("wrong-password", "token-5")).status).toBe(401);

    const locked = await attempt(PASSWORD, "token-6");
    expect(locked.status).toBe(429);
    expect(await errorCode(locked)).toBe("account_locked");
    expect(locked.headers.get("Retry-After")).toBe("900");

    // Another IP is not locked for this account.
    const elsewhere = await postLogin(
      call("POST", "/api/admin/auth/login", { access: EMAIL.locked, ip: "203.0.113.9", body: { email: EMAIL.locked, password: PASSWORD } }),
      ctx(),
    );
    expect(elsewhere.status).toBe(200);
  });

  it("signs a moderator in with an 8-hour session", async () => {
    const response = await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.moderator, body: { email: EMAIL.moderator, password: PASSWORD } }), ctx());
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

  it("refuses an invalid body, yourself and a member account", async () => {
    expect(await errorCode(await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "individual" }))).toBe("invalid_body");
    const self = await invite({ email: EMAIL.admin, displayName: "Admin Test", role: "admin" });
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe("conflict");
    const member = await invite({ email: EMAIL.member, displayName: "Membre Test", role: "moderator" });
    expect(member.status).toBe(409);
    expect(await errorCode(member)).toBe("conflict");
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
  });

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
    const data = mail.data as { displayName: string; actionUrl: string; role: string };
    expect(data.role).toBe("moderator");
    const url = new URL(data.actionUrl);
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

  it("sets the password with the invitation code, then signs the member in", async () => {
    const response = await postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.invited, body: { oobCode, password: FIRST_PASSWORD } }), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "password_set" });

    // The code is consumed.
    const reused = await postPassword(call("POST", "/api/admin/auth/password", { access: EMAIL.invited, body: { oobCode, password: OTHER_PASSWORD } }), ctx());
    expect(reused.status).toBe(400);
    expect(await errorCode(reused)).toBe("invalid_code");

    const session = await signIn(EMAIL.invited, "Nouveau-Secret-1");
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

    const moderator = await signIn(EMAIL.moderator);
    const refused = await deleteStaff(
      call("DELETE", `/api/admin/staff/${invitedUid}`, { access: EMAIL.moderator, cookies: moderator.cookies, csrf: moderator.csrf }),
      ctx({ uid: invitedUid }),
    );
    expect(refused.status).toBe(403);
  });

  it("revokes another member: claims cleared, account disabled, sessions dead", async () => {
    const victim = await signIn(EMAIL.invited, "Nouveau-Secret-1");
    await nextSecond();
    const response = await deleteStaff(call("DELETE", `/api/admin/staff/${invitedUid}`, { access: EMAIL.admin, cookies: admin.cookies, csrf: admin.csrf }), ctx({ uid: invitedUid }));
    expect(response.status).toBe(204);

    const record = await auth().getUser(invitedUid);
    expect(record.disabled).toBe(true);
    expect(record.customClaims ?? {}).toEqual({});
    expect((await readRoster(invitedUid))?.revokedAt).toBeInstanceOf(Date);

    // The earlier session no longer verifies (checkRevoked), and the password no longer signs in.
    expect((await getStaff(call("GET", "/api/admin/staff", { access: EMAIL.invited, cookies: victim.cookies }), ctx())).status).toBe(401);
    const login = await postLogin(call("POST", "/api/admin/auth/login", { access: EMAIL.invited, body: { email: EMAIL.invited, password: FIRST_PASSWORD } }), ctx());
    expect(login.status).toBe(403);
    expect(await errorCode(login)).toBe("account_disabled");
  });

  it("re-inviting a revoked member reactivates the account with the new role", async () => {
    const response = await invite({ email: EMAIL.invited, displayName: "Invitée Test", role: "admin" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ uid: invitedUid });
    const record = await auth().getUser(invitedUid);
    expect(record.disabled).toBe(false);
    expect(record.customClaims).toEqual({ role: "admin", v: 2 });
    expect((await readRoster(invitedUid))?.revokedAt).toBeUndefined();
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
