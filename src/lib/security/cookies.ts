import type { NextResponse } from "next/server";

// Cookies (§6 CSRF, Sessions). `__Host-` prefix: Secure, Path=/, no Domain, so no subdomain
// (media., staging.) can set or read them, and each host (joutiya.ma, admin.joutiya.ma) has its own.
// Browsers accept Secure cookies on http://localhost, so development uses the same names.

export const SESSION_COOKIE = "__Host-session";
/** HMAC of the session, readable by scripts: sent back in the X-CSRF-Token header (signed double submit). */
export const CSRF_COOKIE = "__Host-csrf";
export const CSRF_HEADER = "x-csrf-token";
/** Random device identifier, signed (§6 rate-limit keys). */
export const DEVICE_COOKIE = "__Host-did";
/** Turnstile passed recently (30 min): lifts the IP escalation (§6). */
export const TURNSTILE_PASS_COOKIE = "__Host-tsv";

export const DAY = 24 * 60 * 60;
/** Individual and Pro sessions: 14 days, the Firebase maximum. */
export const USER_SESSION_SECONDS = 14 * DAY;
/** Staff sessions: 8 hours, like the Cloudflare Access session (§6). */
export const STAFF_SESSION_SECONDS = 8 * 60 * 60;
export const DEVICE_SECONDS = 400 * DAY;
export const TURNSTILE_PASS_SECONDS = 30 * 60;

const base = { secure: true, path: "/" } as const;

export function setSessionCookies(response: NextResponse, session: string, csrf: string, maxAge: number): void {
  response.cookies.set(SESSION_COOKIE, session, { ...base, httpOnly: true, sameSite: "lax", maxAge });
  response.cookies.set(CSRF_COOKIE, csrf, { ...base, httpOnly: false, sameSite: "strict", maxAge });
}

export function clearSessionCookies(response: NextResponse): void {
  for (const name of [SESSION_COOKIE, CSRF_COOKIE]) response.cookies.set(name, "", { ...base, maxAge: 0 });
}

export function setDeviceCookie(response: NextResponse, value: string): void {
  response.cookies.set(DEVICE_COOKIE, value, { ...base, httpOnly: true, sameSite: "lax", maxAge: DEVICE_SECONDS });
}

export function setTurnstilePassCookie(response: NextResponse, value: string): void {
  response.cookies.set(TURNSTILE_PASS_COOKIE, value, { ...base, httpOnly: true, sameSite: "strict", maxAge: TURNSTILE_PASS_SECONDS });
}
