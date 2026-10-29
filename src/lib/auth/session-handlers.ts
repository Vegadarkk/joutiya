import "server-only";
import { NextResponse } from "next/server";
import { optionalUser, requireSameOrigin } from "@/lib/auth/guards";
import type { MeResponse } from "@/lib/contracts/auth";
import { revokeSessions, verifySession } from "@/lib/firebase/session";
import { readCookie } from "@/lib/http/cookies";
import { logConnection } from "@/lib/logging/connection-logs";
import { CSRF_HEADER, SESSION_COOKIE, clearSessionCookies } from "@/lib/security/cookies";
import { csrfToken } from "@/lib/security/csrf";
import { deviceOf, jsonResponse, withDevice } from "./respond";
import { sessionSummary } from "./summary";

// Session plumbing: who am I and logout. Google sign-in goes through /api/auth/google only: the
// Firebase ID token exchange (/api/auth/session) was removed, it skipped the GIS nonce binding.

/** The session of the caller, or null (a revoked cookie reads as signed out); the CSRF header lets the UI recover its token. */
export async function handleMe(request: Request): Promise<Response> {
  const context = await optionalUser(request, { checkRevoked: true });
  const body: MeResponse = { session: context ? await sessionSummary(context.user) : null };
  const response = jsonResponse(body);
  if (context) response.headers.set(CSRF_HEADER, csrfToken(context.session));
  return withDevice(response, request);
}

/** Clears the cookies and revokes the account's tokens (§6: a cookie would stay valid until it expires). */
export async function handleLogout(request: Request): Promise<Response> {
  requireSameOrigin(request);
  const cookie = readCookie(request.headers, SESSION_COOKIE);
  const user = cookie ? await verifySession(cookie) : null;
  if (user) {
    await revokeSessions(user.uid);
    await logConnection({ uid: user.uid, event: "logout", ip: deviceOf(request).identity.ip });
  }
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearSessionCookies(response);
  return withDevice(response, request);
}
