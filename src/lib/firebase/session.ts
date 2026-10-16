import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { STAFF_SESSION_SECONDS, USER_SESSION_SECONDS } from "@/lib/security/cookies";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { auth } from "./admin";
import { readClaims, isStaff, type Claims } from "./claims";
import { signInWithCustomToken } from "./rest";

// Firebase session cookies (§6 "Sessions"): minted by the server only, 14 days for members and
// 8 hours for staff. A session is created either from a fresh ID token the browser obtained
// (checked: auth_time, provider, verified e-mail) or directly for a uid after the server itself
// authenticated the person (password or Google ID token): custom token -> ID token -> cookie.

export interface SessionUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  claims: Claims;
  /** Seconds since the epoch of the sign-in this session comes from. */
  authTime: number;
  /** Seconds since the epoch; the cookie is invalid afterwards. */
  expiresAt: number;
  /** Sign-in method recorded by Firebase ("password", "google.com", "custom"). */
  provider: string;
}

export interface MintedSession {
  cookie: string;
  /** Seconds. */
  maxAge: number;
  user: SessionUser;
}

/** Maximum age of an ID token accepted by /api/auth/session (§6: auth_time of 5 minutes). */
export const MAX_ID_TOKEN_AGE_SECONDS = 5 * 60;

function toUser(decoded: DecodedIdToken): SessionUser {
  const claims = readClaims(decoded as unknown as Record<string, unknown>);
  return {
    uid: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.email_verified === true,
    claims,
    authTime: decoded.auth_time,
    expiresAt: decoded.exp,
    provider: decoded.firebase?.sign_in_provider ?? "unknown",
  };
}

function sessionSeconds(claims: Claims): number {
  return isStaff(claims) ? STAFF_SESSION_SECONDS : USER_SESSION_SECONDS;
}

async function mint(idToken: string): Promise<MintedSession> {
  const decoded = await auth().verifyIdToken(idToken);
  const user = toUser(decoded);
  const maxAge = sessionSeconds(user.claims);
  const cookie = await auth().createSessionCookie(idToken, { expiresIn: maxAge * 1000 });
  return { cookie, maxAge, user: { ...user, expiresAt: Math.floor(Date.now() / 1000) + maxAge } };
}

/**
 * Session for an account the server has just authenticated itself. The custom token is only an
 * internal step: it never reaches a browser.
 */
export async function createSessionForUid(uid: string): Promise<MintedSession> {
  const custom = await auth().createCustomToken(uid);
  const { idToken } = await signInWithCustomToken(custom);
  return mint(idToken);
}

export interface IdTokenSessionOptions {
  /** Providers accepted for this exchange (§6: google.com only for the browser flow). */
  providers: readonly string[];
  now?: number;
}

/**
 * Session from an ID token the browser obtained. Refused (§6): a token older than 5 minutes, a
 * provider outside `providers`, an unverified e-mail, an account without a role.
 */
export async function createSessionFromIdToken(idToken: string, options: IdTokenSessionOptions): Promise<MintedSession> {
  let decoded: DecodedIdToken;
  try {
    decoded = await auth().verifyIdToken(idToken, true);
  } catch {
    throw new HttpError(401, "invalid_credentials");
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (now - decoded.auth_time > MAX_ID_TOKEN_AGE_SECONDS) throw new HttpError(401, "invalid_credentials", "recent sign-in required");
  const provider = decoded.firebase?.sign_in_provider ?? "";
  if (!options.providers.includes(provider)) throw new HttpError(401, "invalid_credentials", "provider not accepted");
  if (decoded.email_verified !== true) throw new HttpError(403, "email_not_verified");
  if (!readClaims(decoded as unknown as Record<string, unknown>).role) throw new HttpError(403, "role_missing");
  return mint(idToken);
}

export interface VerifySessionOptions {
  /** Looks the account up (disabled, revoked): sensitive routes and every staff request (§6). */
  checkRevoked?: boolean;
}

/** The person behind a session cookie, or null when it is absent, forged, expired or revoked. */
export async function verifySession(cookie: string | undefined, options: VerifySessionOptions = {}): Promise<SessionUser | null> {
  if (!cookie || cookie.length > 4096) return null;
  try {
    const decoded = await auth().verifySessionCookie(cookie, options.checkRevoked === true);
    return toUser(decoded);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (!/expired|revoked|argument-error|user-not-found|user-disabled/.test(code)) {
      logger.warn({ code }, "session cookie verification failed");
    }
    return null;
  }
}

/** Server-side logout: the cookie stays valid until its expiry otherwise (§6). */
export async function revokeSessions(uid: string): Promise<void> {
  await auth().revokeRefreshTokens(uid);
}

/**
 * Session from the ID token of a sign-in the server itself just performed through the Identity
 * Toolkit REST API (password check, re-authentication). The token is seconds old and its provider is
 * the real one ("password"), so no age or provider check applies here.
 */
export async function createSessionFromServerSignIn(idToken: string): Promise<MintedSession> {
  return mint(idToken);
}
