import "server-only";
import { NextResponse } from "next/server";
import { optionalUser, requireSameOrigin } from "@/lib/auth/guards";
import { sessionSchema, type MeResponse, type SessionResponse } from "@/lib/contracts/auth";
import { linkProvider } from "@/lib/db/repositories/users";
import { isStaff } from "@/lib/firebase/claims";
import { createSessionFromIdToken, revokeSessions, verifySession } from "@/lib/firebase/session";
import { forbidden } from "@/lib/http/errors";
import { readCookie } from "@/lib/http/cookies";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { CSRF_HEADER, SESSION_COOKIE, clearSessionCookies } from "@/lib/security/cookies";
import { csrfToken } from "@/lib/security/csrf";
import { anonymous, beginAnonymous, finish } from "./anonymous";
import { deviceOf, jsonResponse, signedIn, withDevice } from "./respond";
import { sessionSummary } from "./summary";

// Session plumbing: who am I, logout, and the Google popup exchange.

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

/** Firebase ID token of a Google popup sign-in (existing account) -> session cookie (§6). */
async function session(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, sessionSchema);
  await enforceLimit("google.ip", flow.identity.ipBucket);
  await enforceLimit("google.device", flow.identity.deviceKey);
  const minted = await createSessionFromIdToken(input.idToken, { providers: ["google.com"] });
  if (isStaff(minted.user.claims)) throw forbidden("staff accounts sign in on the back office");
  await linkProvider(minted.user.uid, "google.com").catch((error: unknown) => logger.warn({ err: (error as Error).message }, "providers update skipped"));
  await logConnection({ uid: minted.user.uid, event: "google_login", ip: flow.identity.ip });
  const body: SessionResponse = { status: "signed_in", session: await sessionSummary(minted.user) };
  return finish(flow, signedIn(minted, body));
}

export const handleSession = anonymous(session);
