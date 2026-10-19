import "server-only";
import { serverEnv } from "@/lib/env";
import { auth } from "@/lib/firebase/admin";
import { isMember, isStaff, type Claims, type Role } from "@/lib/firebase/claims";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { HttpError, forbidden, notFound, unauthenticated } from "@/lib/http/errors";
import { readCookie } from "@/lib/http/cookies";
import { ACCESS_JWT_HEADER, verifyAccessJwt } from "@/lib/auth/access-jwt";
import { CSRF_HEADER, SESSION_COOKIE } from "@/lib/security/cookies";
import { isValidCsrf } from "@/lib/security/csrf";
import { hostKind, isSameOrigin, type HostKind } from "@/lib/security/origin";

// Authorization guards (§6 "Contrôle d'accès"): called in EVERY route handler and protected
// layout. proxy.ts is never a barrier. Guards work on the plain Request so they are unit-testable
// and identical in route handlers; pages use src/lib/auth/current-user.ts to read the cookie.

export interface AuthContext {
  user: SessionUser;
  /** Raw session cookie (CSRF token derivation, re-minting). */
  session: string;
  host: HostKind;
}

export interface GuardOptions {
  /** Mutations need the Origin header of this host and the signed CSRF header (§6 CSRF). */
  mutation?: boolean;
  /**
   * Looks the account up: disabled or revoked sessions are refused. Defaults to true on every
   * request (one Auth lookup, free on Spark): a cookie that logout, a password change or a ban
   * already revoked must neither read nor mutate anything. A route may pass false explicitly.
   */
  checkRevoked?: boolean;
  /** A suspended account may still reach the routes it is allowed (conversations, export, appeal). */
  allowSuspended?: boolean;
}

/** Origin must be present and equal to this host's origin; otherwise 403 (§6 CSRF). */
export function requireSameOrigin(request: Request): HostKind {
  const kind = hostKind(request.headers);
  if (!isSameOrigin(request.headers, kind)) throw new HttpError(403, "origin", "missing or foreign Origin");
  return kind;
}

/** Signed double submit: X-CSRF-Token must be the HMAC of the session cookie. */
export function requireCsrf(request: Request, session: string): void {
  if (!isValidCsrf(session, request.headers.get(CSRF_HEADER))) throw new HttpError(403, "csrf");
}

/** The signed-in person, or null. Never throws. */
export async function optionalUser(request: Request, options: Pick<GuardOptions, "checkRevoked"> = {}): Promise<AuthContext | null> {
  const session = readCookie(request.headers, SESSION_COOKIE);
  if (!session) return null;
  const user = await verifySession(session, { checkRevoked: options.checkRevoked });
  return user ? { user, session, host: hostKind(request.headers) } : null;
}

/**
 * A signed-in member (individual or pro). 401 without a valid session; 403 `role_missing` for an
 * account whose e-mail is not activated yet; 403 `account_suspended` unless allowed.
 */
export async function requireUser(request: Request, options: GuardOptions = {}): Promise<AuthContext> {
  const host = options.mutation ? requireSameOrigin(request) : hostKind(request.headers);
  const session = readCookie(request.headers, SESSION_COOKIE);
  if (!session) throw unauthenticated();
  if (options.mutation) requireCsrf(request, session);
  const user = await verifySession(session, { checkRevoked: options.checkRevoked ?? true });
  if (!user) throw unauthenticated();
  if (host !== "public") throw notFound();
  if (!isMember(user.claims)) throw new HttpError(403, "role_missing");
  if (user.claims.st === "suspended" && !options.allowSuspended) throw new HttpError(403, "account_suspended");
  return { user, session, host };
}

/** requireUser, then the role must be one of `roles` (403 otherwise). */
export async function requireRole(request: Request, roles: readonly Role[], options: GuardOptions = {}): Promise<AuthContext> {
  const context = await requireUser(request, options);
  if (!context.user.claims.role || !roles.includes(context.user.claims.role)) throw forbidden();
  return context;
}

/**
 * Ownership check (IDOR): a resource of someone else answers 404, never 403, so the existence of
 * the resource is not revealed. A shop member (proId) owns the shop's resources.
 */
export function requireOwner(context: AuthContext, resource: { ownerUid: string; proId?: string | null }): void {
  const { uid, claims } = context.user;
  if (resource.ownerUid === uid) return;
  if (resource.proId && claims.proId && resource.proId === claims.proId) return;
  throw notFound();
}

export interface StaffContext extends AuthContext {
  role: Extract<Role, "moderator" | "admin">;
  /** E-mail asserted by Cloudflare Access (second factor), lower-cased. */
  accessEmail: string;
}

export interface StaffGuardOptions extends Pick<GuardOptions, "mutation"> {
  /** Restrict to these staff roles (default: moderator and admin). */
  roles?: readonly Extract<Role, "moderator" | "admin">[];
}

/**
 * Cloudflare Access identity of a back-office request (§6 "Personnel"). Dev without CF_ACCESS_AUD
 * skips Access (there is none locally); deployed environments refuse to start without it.
 */
export async function accessIdentity(request: Request): Promise<{ email: string } | null> {
  const env = serverEnv();
  if (env.APP_ENV === "dev" && !env.CF_ACCESS_AUD) {
    const devEmail = request.headers.get("x-dev-access-email");
    return { email: (devEmail ?? "dev@joutiya.test").toLowerCase() };
  }
  const identity = await verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), {
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? "",
    audience: env.CF_ACCESS_AUD ?? "",
  });
  return identity ? { email: identity.email } : null;
}

/**
 * Staff guard (§6): admin host only (404 elsewhere), valid Access JWT whose e-mail is the staff
 * account's e-mail, role moderator or admin, revocation checked on every request, 8-hour cookie.
 */
export async function requireStaff(request: Request, options: StaffGuardOptions = {}): Promise<StaffContext> {
  if (hostKind(request.headers) !== "admin") throw notFound();
  if (options.mutation) requireSameOrigin(request);
  const access = await accessIdentity(request);
  if (!access) throw unauthenticated("Access token required");
  const session = readCookie(request.headers, SESSION_COOKIE);
  if (!session) throw unauthenticated();
  if (options.mutation) requireCsrf(request, session);
  const user = await verifySession(session, { checkRevoked: true });
  if (!user) throw unauthenticated();
  if (!isStaff(user.claims) || !user.claims.role) throw forbidden();
  if ((user.email ?? "").toLowerCase() !== access.email) throw forbidden("Access identity does not match the staff account");
  const role = user.claims.role as StaffContext["role"];
  if (options.roles && !options.roles.includes(role)) throw forbidden();
  return { user, session, host: "admin", role, accessEmail: access.email };
}

/** Fresh account record for sensitive changes (e-mail change, closure): disabled accounts are refused. */
export async function requireActiveAccount(uid: string): Promise<{ email?: string; emailVerified: boolean; claims: Claims }> {
  const record = await auth().getUser(uid);
  if (record.disabled) throw new HttpError(403, "account_disabled");
  return { email: record.email, emailVerified: record.emailVerified, claims: record.customClaims as Claims };
}
