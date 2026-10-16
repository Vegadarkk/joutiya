import "server-only";
import { NextResponse } from "next/server";
import type { MintedSession } from "@/lib/firebase/session";
import { requestIdentity, type RequestIdentity } from "@/lib/rate-limit/keys";
import { CSRF_HEADER, setDeviceCookie, setSessionCookies, setTurnstilePassCookie } from "@/lib/security/cookies";
import { csrfToken } from "@/lib/security/csrf";
import { newDeviceCookie } from "@/lib/security/device";
import { turnstilePass } from "@/lib/security/turnstile";

// Responses of the auth routes: session cookies + CSRF token, device cookie, Turnstile pass.
// Built on NextResponse for its cookie API; apiRoute adds Cache-Control: no-store when missing.

export function jsonResponse<T>(body: T, init: ResponseInit = {}): NextResponse<T> {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** `body` plus the session cookies; the CSRF token is also in the header so the client can store it at once. */
export function signedIn<T>(minted: MintedSession, body: T, init: ResponseInit = {}): NextResponse<T> {
  const response = jsonResponse(body, init);
  const csrf = csrfToken(minted.cookie);
  setSessionCookies(response, minted.cookie, csrf, minted.maxAge);
  response.headers.set(CSRF_HEADER, csrf);
  return response;
}

export interface Device {
  identity: RequestIdentity;
  /** Fresh signed cookie to set when the request carried none (or a forged one). */
  fresh: { id: string; value: string } | null;
  /** Device key the client presents on its next request: the fresh id once the cookie is set. */
  nextKey: string;
}

/** Rate-limit identity of the request and the device cookie its response must set. */
export function deviceOf(request: Request): Device {
  const identity = requestIdentity(request.headers);
  if (identity.deviceId) return { identity, fresh: null, nextKey: identity.deviceKey };
  const fresh = newDeviceCookie();
  return { identity, fresh, nextKey: `d:${fresh.id}` };
}

export function applyDevice<T>(response: NextResponse<T>, device: Device): NextResponse<T> {
  if (device.fresh) setDeviceCookie(response, device.fresh.value);
  return response;
}

/** Sets __Host-did when the request had no valid device cookie. */
export function withDevice<T>(response: NextResponse<T>, request: Request): NextResponse<T> {
  return applyDevice(response, deviceOf(request));
}

/** Turnstile solved: the pass lifts the escalation for 30 minutes on this device (§6). */
export function applyTurnstilePass<T>(response: NextResponse<T>, device: Device): NextResponse<T> {
  setTurnstilePassCookie(response, turnstilePass(device.nextKey));
  return response;
}
