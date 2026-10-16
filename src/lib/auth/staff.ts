import "server-only";
import type { UserRecord } from "firebase-admin/auth";
import { NextResponse } from "next/server";
import { z } from "@/lib/zod";
import { RATE_LIMITS } from "@/config/rate-limits";
import { audit } from "@/lib/audit";
import { accessIdentity, requireSameOrigin, type StaffContext } from "@/lib/auth/guards";
import { assertPasswordPolicy } from "@/lib/auth/password-policy";
import { displayNameSchema, emailSchema, PASSWORD_MAX } from "@/lib/contracts/auth";
import { getStaff, listStaff, revokeStaff, staffRoleSchema, upsertStaff, type StaffRecord, type StaffRole } from "@/lib/db/repositories/staff";
import { emailNormHash } from "@/lib/db/repositories/users";
import { serverEnv } from "@/lib/env";
import { auth } from "@/lib/firebase/admin";
import { isStaff, readClaims, setClaims } from "@/lib/firebase/claims";
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
import { forbidden, HttpError, notFound, unauthenticated, unavailable } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { logConnection } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { requestIdentity, type RequestIdentity } from "@/lib/rate-limit/keys";
import { blockLimit, consumeLimit, enforceLimit, limitState, resetLimit } from "@/lib/rate-limit/limiter";
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
    /**
     * Required on every attempt once a Turnstile site key is configured (every deployed
     * environment); without keys, from the 3rd failure (the previous answer says `turnstile_required`).
     */
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type StaffLoginInput = z.infer<typeof staffLoginSchema>;

/** Staff passwords are longer than member passwords (owner guide, docs/phase-2.md §8: 12 or more). */
export const STAFF_PASSWORD_MIN = 12;

/** First password of an invited member, or a later reset: the oobCode comes from the invitation link. */
export const staffPasswordSchema = z
  .object({
    oobCode: z.string().min(10).max(512),
    password: z.string().min(STAFF_PASSWORD_MIN).max(PASSWORD_MAX),
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

// Login policy (§6 table, /api/auth/login row, applied to the staff limiter): 300 attempts per hour
// per IP, 5 failures per account + IP in 15 min then a 15 min lock, Turnstile on every attempt
// when the widget is configured (else from the 3rd failure, or the 20th per hour on the account).
const LOGIN_LIMIT = "staff.login.accountIp";
const ACCOUNT_LIMIT = "login.fail.account";
const TURNSTILE_AFTER_FAILURES = 3;
const LOCK_AFTER_FAILURES = RATE_LIMITS[LOGIN_LIMIT].points;
const LOCK_SECONDS = RATE_LIMITS[LOGIN_LIMIT].blockDuration;
const ACCOUNT_FAILURE_LIMIT = RATE_LIMITS[ACCOUNT_LIMIT].points;

function accountLocked(retryAfterSeconds: number): HttpError {
  return new HttpError(429, "account_locked", undefined, { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) } });
}

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
 * POST /api/admin/auth/login. Access identity and body e-mail must match. Limits fail closed (503
 * when valkey-ratelimit is down): 300 attempts per hour per IP; 5 failures per account + IP in
 * 15 min lock the pair for 15 min from the failure that filled the window; Turnstile on every
 * attempt when a site key is configured (without keys: from the 3rd failure on the pair or the
 * 20th per hour on the account, any token accepted). A member account (individual, pro) is
 * refused and counts as a failure. Success: 8-hour session cookie.
 */
export async function login(request: Request): Promise<Response> {
  requireAdminHost(request);
  requireSameOrigin(request);
  const access = await requireAccess(request);
  const body = await readJson(request, staffLoginSchema);
  if (body.email !== access.email) throw forbidden("Access identity does not match");

  const identity = requestIdentity(request.headers);
  await enforceLimit("login.ip", identity.ipBucket);
  const account = emailNormHash(body.email);
  const accountIp = `${account}:${identity.ipBucket}`;
  const [pair, perAccount] = await Promise.all([limitState(LOGIN_LIMIT, accountIp), limitState(ACCOUNT_LIMIT, account)]);
  // An unreadable counter never reads as "no failures": the staff limiter's policy is closed.
  if (!pair || !perAccount) throw unavailable("rate limiter unavailable");
  // Retry-After is the store's own time left on the block set by the failure that filled the window.
  if (pair.consumedPoints >= LOCK_AFTER_FAILURES) throw accountLocked(pair.msBeforeNext > 0 ? pair.msBeforeNext / 1000 : LOCK_SECONDS);

  const turnstileNeeded = Boolean(serverEnv().TURNSTILE_SITE_KEY) || pair.consumedPoints >= TURNSTILE_AFTER_FAILURES || perAccount.consumedPoints >= ACCOUNT_FAILURE_LIMIT;
  if (turnstileNeeded) {
    // Nothing counted yet: no credential has been looked at.
    if (!body.turnstileToken) return json<StaffLoginResponse>({ status: "turnstile_required" });
    const hostname = new URL(expectedOrigin("admin")).hostname;
    const check = await verifyTurnstile(body.turnstileToken, { action: "staff-login", remoteIp: identity.ip, hostname });
    if (!check.ok) throw new HttpError(400, "turnstile_failed");
  }

  /** A failure on the pair and on the account; the one that fills the window locks the pair for blockDuration right away. */
  const fail = async (): Promise<void> => {
    const [counted] = await Promise.all([consumeLimit(LOGIN_LIMIT, accountIp), consumeLimit(ACCOUNT_LIMIT, account)]);
    if (counted.ok && counted.remaining === 0) await blockLimit(LOGIN_LIMIT, accountIp);
  };

  let localId: string;
  try {
    ({ localId } = await signInWithPassword(body.email, body.password));
  } catch (error) {
    if (error instanceof IdentityToolkitError) {
      if (INVALID_CREDENTIAL_CODES.has(error.code)) {
        await fail();
        throw new HttpError(401, "invalid_credentials");
      }
      if (error.code === "USER_DISABLED") throw new HttpError(403, "account_disabled");
      if (error.code.startsWith("TOO_MANY_ATTEMPTS")) throw accountLocked(LOCK_SECONDS);
    }
    throw error;
  }

  const record = await auth().getUser(localId);
  const claims = readClaims(record.customClaims ?? {});
  if (!isStaff(claims) || !claims.role) {
    // A valid password on a non-staff account is still a failed back-office login.
    await fail();
    throw forbidden();
  }
  const role = claims.role as StaffRole;

  const minted = await createSessionForUid(record.uid);
  await resetLimit(LOGIN_LIMIT, accountIp);
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
  // Same policy as member passwords (common list, nothing personal, no trivial pattern), on top of
  // the longer minimum of staffPasswordSchema; checked before the code is consumed.
  assertPasswordPolicy(body.password, { email, displayName: record.displayName });

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
 * An account this module or scripts/create-admin.ts created: staff claims, or a roster entry (a
 * revoked member has no claims any more). Any other account keeps its own password and is never
 * promoted: a sign-up never confirmed, or a member account, would otherwise become staff with the
 * password of whoever registered that address.
 */
async function isStaffAccount(record: UserRecord): Promise<boolean> {
  return isStaff(readClaims(record.customClaims ?? {})) || (await getStaff(record.uid)) !== null;
}

/**
 * POST /api/admin/staff: creates the Auth account (or reuses a staff one, revoked included), writes
 * the roster entry, sets the staff claims and mails the set-password link. Refused with 409: the
 * caller themself (nobody grants a role to themself, §6) and any existing non-staff account (staff
 * accounts are separate from shopper accounts).
 */
export async function invite(ctx: StaffContext, input: InviteInput, identity: RequestIdentity): Promise<StaffInviteResponse> {
  const existing = await auth().getUserByEmail(input.email).catch(() => null);
  if (existing && existing.uid === ctx.user.uid) throw new HttpError(409, "conflict", "cannot invite yourself");
  if (existing && !(await isStaffAccount(existing))) throw new HttpError(409, "conflict", "a Joutiya account exists with this e-mail");
  const uid = existing?.uid ?? (await auth().createUser({ email: input.email, emailVerified: true, displayName: input.displayName })).uid;
  if (existing && (existing.disabled || existing.displayName !== input.displayName)) {
    // Re-invitation of a revoked or renamed member: the account is active again.
    await auth().updateUser(uid, { disabled: false, displayName: input.displayName });
  }
  // Roster before claims: an interrupted call leaves an entry without rights, never the reverse.
  await upsertStaff({ uid, email: input.email, displayName: input.displayName, role: input.role, invitedBy: ctx.user.uid });
  await setClaims(uid, { role: input.role, v: 2 });

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

/** Revocation here never touches Cloudflare Access: the admin removes the person from its policy by hand. */
export const REVOKE_ACCESS_REMINDER = "retirer aussi de Cloudflare Access";

/**
 * DELETE /api/admin/staff/[uid]: clears the claims, revokes every session, disables the Auth
 * account and marks the roster entry revoked. Never on oneself (403); unknown member: 404. An
 * account with staff claims but no roster entry (a bootstrap stopped halfway) is revoked all the
 * same, with a roster tombstone so the /personnel page shows it.
 */
export async function revoke(ctx: StaffContext, uid: string, identity: RequestIdentity): Promise<void> {
  if (uid === ctx.user.uid) throw forbidden("a member cannot revoke themself");
  const target = await getStaff(uid);
  if (!target) {
    const record = await auth().getUser(uid).catch(() => null);
    const claims = record ? readClaims(record.customClaims ?? {}) : {};
    if (!record?.email || !isStaff(claims) || !claims.role) throw notFound();
    const displayName = displayNameSchema.safeParse(record.displayName);
    await upsertStaff({ uid, email: record.email, displayName: displayName.success ? displayName.data : "Membre", role: claims.role as StaffRole, invitedBy: "script" });
  }
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
    reason: REVOKE_ACCESS_REMINDER,
  });
}
