import "server-only";
import { NextResponse } from "next/server";
import { z } from "@/lib/zod";
import { audit } from "@/lib/audit";
import { accessIdentity, requireSameOrigin, type StaffContext } from "@/lib/auth/guards";
import { displayNameSchema, emailSchema, PASSWORD_MAX, PASSWORD_MIN } from "@/lib/contracts/auth";
import { getStaff, listStaff, revokeStaff, staffRoleSchema, upsertStaff, type StaffRecord, type StaffRole } from "@/lib/db/repositories/staff";
import { emailNormHash } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { isMember, isStaff, readClaims, setClaims } from "@/lib/firebase/claims";
import {
  confirmPasswordReset,
  IdentityToolkitError,
  INVALID_CODE_CODES,
  INVALID_CREDENTIAL_CODES,
  signInWithPassword,
  verifyPasswordResetCode,
} from "@/lib/firebase/rest";
import { createSessionForUid, revokeSessions, verifySession } from "@/lib/firebase/session";
import { readCookie } from "@/lib/http/cookies";
import { forbidden, HttpError, notFound, unauthenticated } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { logConnection } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { requestIdentity, type RequestIdentity } from "@/lib/rate-limit/keys";
import { consumedPoints, consumeLimit, enforceLimit, resetLimit } from "@/lib/rate-limit/limiter";
import { clearSessionCookies, CSRF_HEADER, SESSION_COOKIE, setSessionCookies } from "@/lib/security/cookies";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin, hostKind } from "@/lib/security/origin";
import { verifyTurnstile } from "@/lib/security/turnstile";

// Staff authentication and roster (§6 "Personnel"): password sign-in behind Cloudflare Access on
// the admin host, 8-hour sessions, invitations and revocations by an admin (never on oneself).
// The route handlers under src/app/api/admin are thin: everything testable lives here.

// Contracts (shared with the back-office forms).

export const staffLoginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(PASSWORD_MAX),
    /** Required from the 3rd failure on this account + IP (the previous answer says `turnstile_required`). */
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type StaffLoginInput = z.infer<typeof staffLoginSchema>;

/** First password of an invited member, or a later reset: the oobCode comes from the invitation link. */
export const staffPasswordSchema = z
  .object({
    oobCode: z.string().min(10).max(512),
    password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  })
  .strict();
export type StaffPasswordInput = z.infer<typeof staffPasswordSchema>;

export const inviteSchema = z
  .object({
    email: emailSchema,
    displayName: displayNameSchema,
    role: staffRoleSchema,
  })
  .strict();
export type InviteInput = z.infer<typeof inviteSchema>;

export interface StaffSummary {
  uid: string;
  email: string;
  role: StaffRole;
  displayName: string | null;
}

export type StaffLoginResponse = { status: "signed_in"; staff: StaffSummary } | { status: "turnstile_required" };
export type StaffPasswordResponse = { status: "password_set" };
export type StaffInviteResponse = { uid: string };

/** One roster row, dates as ISO strings (the API answer and the /personnel table). */
export interface StaffMember {
  uid: string;
  email: string;
  displayName: string;
  role: StaffRole;
  invitedBy: string;
  createdAt: string;
  revokedAt: string | null;
}
export interface StaffListResponse {
  staff: StaffMember[];
}

export const STAFF_API = {
  login: "/api/admin/auth/login",
  logout: "/api/admin/auth/logout",
  password: "/api/admin/auth/password",
  staff: "/api/admin/staff",
} as const;

// Login policy (§6 table, /api/auth/login row, applied to the staff limiter).
const LOGIN_LIMIT = "staff.login.accountIp";
const TURNSTILE_AFTER_FAILURES = 3;
const LOCK_AFTER_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;

/** Back-office routes exist on the admin host only: 404 elsewhere, like requireStaff. */
function requireAdminHost(request: Request): void {
  if (hostKind(request.headers) !== "admin") throw notFound();
}

/** Cloudflare Access identity, mandatory before any credential is looked at. */
async function requireAccess(request: Request): Promise<{ email: string }> {
  const access = await accessIdentity(request);
  if (!access) throw unauthenticated("Access token required");
  return access;
}

function translateCodeError(error: unknown): unknown {
  if (!(error instanceof IdentityToolkitError)) return error;
  if (error.code === "EXPIRED_OOB_CODE") return new HttpError(400, "expired_code");
  if (INVALID_CODE_CODES.has(error.code)) return new HttpError(400, "invalid_code");
  if (error.code.startsWith("WEAK_PASSWORD")) return new HttpError(400, "weak_password");
  return error;
}

/**
 * POST /api/admin/auth/login. Access identity and body e-mail must match; 5 failures per account
 * + IP in 15 min lock the pair for 15 min, Turnstile is required from the 3rd failure; a member
 * account (individual, pro) is refused and counts as a failure. Success: 8-hour session cookie.
 */
export async function login(request: Request): Promise<Response> {
  requireAdminHost(request);
  requireSameOrigin(request);
  const access = await requireAccess(request);
  const body = await readJson(request, staffLoginSchema);
  if (body.email !== access.email) throw forbidden("Access identity does not match");

  const identity = requestIdentity(request.headers);
  const key = `${emailNormHash(body.email)}:${identity.ipBucket}`;
  const failures = (await consumedPoints(LOGIN_LIMIT, key)) ?? 0;
  if (failures >= LOCK_AFTER_FAILURES) {
    throw new HttpError(429, "account_locked", undefined, { headers: { "Retry-After": String(LOCK_SECONDS) } });
  }
  if (failures >= TURNSTILE_AFTER_FAILURES) {
    if (!body.turnstileToken) return json<StaffLoginResponse>({ status: "turnstile_required" });
    const check = await verifyTurnstile(body.turnstileToken, { action: "staff-login", remoteIp: identity.ip });
    if (!check.ok) throw new HttpError(400, "turnstile_failed");
  }

  let localId: string;
  try {
    ({ localId } = await signInWithPassword(body.email, body.password));
  } catch (error) {
    if (error instanceof IdentityToolkitError) {
      if (INVALID_CREDENTIAL_CODES.has(error.code)) {
        await consumeLimit(LOGIN_LIMIT, key);
        throw new HttpError(401, "invalid_credentials");
      }
      if (error.code === "USER_DISABLED") throw new HttpError(403, "account_disabled");
      if (error.code.startsWith("TOO_MANY_ATTEMPTS")) {
        throw new HttpError(429, "account_locked", undefined, { headers: { "Retry-After": String(LOCK_SECONDS) } });
      }
    }
    throw error;
  }

  const record = await auth().getUser(localId);
  const claims = readClaims(record.customClaims ?? {});
  if (!isStaff(claims) || !claims.role) {
    // A valid password on a non-staff account is still a failed back-office login.
    await consumeLimit(LOGIN_LIMIT, key);
    throw forbidden();
  }
  const role = claims.role as StaffRole;

  const minted = await createSessionForUid(record.uid);
  await resetLimit(LOGIN_LIMIT, key);
  const userAgent = request.headers.get("user-agent")?.slice(0, 200);
  await logConnection({ uid: record.uid, event: "staff_login", ip: identity.ip, ...(userAgent ? { userAgent } : {}) });

  const payload: StaffLoginResponse = {
    status: "signed_in",
    staff: { uid: record.uid, email: access.email, role, displayName: record.displayName ?? null },
  };
  const response = NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  const csrf = csrfToken(minted.cookie);
  setSessionCookies(response, minted.cookie, csrf, minted.maxAge);
  response.headers.set(CSRF_HEADER, csrf);
  return response;
}

/** POST /api/admin/auth/logout: revokes the session when there is one, clears the cookies, 204. */
export async function logout(request: Request): Promise<Response> {
  requireAdminHost(request);
  requireSameOrigin(request);
  const session = readCookie(request.headers, SESSION_COOKIE);
  const user = session ? await verifySession(session) : null;
  if (user) await revokeSessions(user.uid);
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearSessionCookies(response);
  return response;
}

/**
 * POST /api/admin/auth/password: an invited member sets the first password (or resets it later)
 * with the oobCode of the invitation link. The code's e-mail must be the Access identity and the
 * account must be staff; every session of the account is then revoked.
 */
export async function setPassword(request: Request): Promise<Response> {
  requireAdminHost(request);
  requireSameOrigin(request);
  const access = await requireAccess(request);
  const body = await readJson(request, staffPasswordSchema);
  const identity = requestIdentity(request.headers);
  await enforceLimit("action.ip", identity.ipBucket);

  let email: string;
  try {
    const checked = await verifyPasswordResetCode(body.oobCode);
    email = (checked.email ?? "").toLowerCase();
  } catch (error) {
    throw translateCodeError(error);
  }
  if (!email || email !== access.email) throw forbidden("Access identity does not match");
  const record = await auth().getUserByEmail(email).catch(() => null);
  if (!record || !isStaff(readClaims(record.customClaims ?? {}))) throw forbidden();
  if (record.disabled) throw new HttpError(403, "account_disabled");

  try {
    await confirmPasswordReset(body.oobCode, body.password);
  } catch (error) {
    throw translateCodeError(error);
  }
  await revokeSessions(record.uid);
  return json<StaffPasswordResponse>({ status: "password_set" });
}

function toMember(record: StaffRecord): StaffMember {
  return {
    uid: record.uid,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    invitedBy: record.invitedBy,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
  };
}

/** GET /api/admin/staff (admin only, checked by the caller): the roster, oldest first. */
export async function list(): Promise<StaffListResponse> {
  return { staff: (await listStaff()).map(toMember) };
}

/** Invitation link: our own page, the oobCode of the Admin SDK link (the Firebase page is never used). */
export function invitationUrl(oobCode: string, origin = expectedOrigin("admin")): string {
  return `${origin}/connexion?mode=setPassword&oobCode=${encodeURIComponent(oobCode)}`;
}

/**
 * POST /api/admin/staff: creates (or reuses) the Auth account, sets the staff claims, writes the
 * roster entry and mails the set-password link. Refused: the caller themself (nobody grants a role
 * to themself, §6) and a member account (staff accounts are separate from shopper accounts).
 */
export async function invite(ctx: StaffContext, input: InviteInput, identity: RequestIdentity): Promise<StaffInviteResponse> {
  const existing = await auth().getUserByEmail(input.email).catch(() => null);
  if (existing && existing.uid === ctx.user.uid) throw new HttpError(409, "conflict", "cannot invite yourself");
  if (existing && isMember(readClaims(existing.customClaims ?? {}))) {
    throw new HttpError(409, "conflict", "a member account cannot become staff");
  }
  const uid = existing?.uid ?? (await auth().createUser({ email: input.email, emailVerified: true, displayName: input.displayName })).uid;
  if (existing && (existing.disabled || existing.displayName !== input.displayName)) {
    // Re-invitation of a revoked or renamed member: the account is active again.
    await auth().updateUser(uid, { disabled: false, displayName: input.displayName });
  }
  await setClaims(uid, { role: input.role, v: 2 });
  await upsertStaff({ uid, email: input.email, displayName: input.displayName, role: input.role, invitedBy: ctx.user.uid });

  const origin = expectedOrigin("admin");
  try {
    const link = await auth().generatePasswordResetLink(input.email, { url: `${origin}/connexion` });
    const oobCode = new URL(link).searchParams.get("oobCode");
    if (!oobCode) throw new Error("the generated link carries no oobCode");
    await sendMail({
      template: "staffInvite",
      locale: "fr",
      to: input.email,
      data: { displayName: input.displayName, actionUrl: invitationUrl(oobCode, origin), role: input.role },
      priority: "security",
    });
  } catch (error) {
    // The account and its role exist; the admin can invite again to resend the link.
    logger.error({ err: (error as Error).message, uid }, "staff invitation mail failed");
  }
  await audit({
    actorUid: ctx.user.uid,
    actorRole: ctx.role,
    action: "staff.invite",
    target: { type: "staff", id: uid },
    automated: false,
    ip: identity.ip,
    reason: input.role,
  });
  return { uid };
}

/**
 * DELETE /api/admin/staff/[uid]: clears the claims, revokes every session, disables the Auth
 * account and marks the roster entry revoked. Never on oneself (403); unknown member: 404.
 */
export async function revoke(ctx: StaffContext, uid: string, identity: RequestIdentity): Promise<void> {
  if (uid === ctx.user.uid) throw forbidden("a member cannot revoke themself");
  const target = await getStaff(uid);
  if (!target) throw notFound();
  await setClaims(uid, null);
  await revokeSessions(uid);
  await auth().updateUser(uid, { disabled: true });
  await revokeStaff(uid);
  await audit({
    actorUid: ctx.user.uid,
    actorRole: ctx.role,
    action: "staff.revoke",
    target: { type: "staff", id: uid },
    automated: false,
    ip: identity.ip,
  });
}
