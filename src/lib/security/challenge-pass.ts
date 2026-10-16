import "server-only";
import { readCookie } from "@/lib/http/cookies";
import { DEVICE_COOKIE, TURNSTILE_PASS_COOKIE, TURNSTILE_PASS_SECONDS } from "./cookies";
import { readDeviceId } from "./device";
import { hasTurnstilePass, turnstilePass } from "./turnstile";

// Challenge pass (§6, design D13/D14): once a visitor solved Turnstile, `__Host-tsv` lifts the search
// and page limits for 30 minutes, within their own "passed" allowance. Bound to the signed device
// cookie `__Host-did`: without a valid device id there is no pass. Same signed value as the pass of
// the auth flows (security/turnstile.ts, binding `d:<device id>`): one cookie name, one format, so
// neither flow erases the other's pass. Plain Request API: usable from proxy.ts and route handlers.

/** Rate-limit binding of a device id (`deviceKey` of src/lib/rate-limit/keys.ts). */
function binding(deviceId: string): string {
  return `d:${deviceId}`;
}

/** Device id of the request's valid `__Host-did`, or null. */
export function requestDeviceId(request: Request): string | null {
  return readDeviceId(readCookie(request.headers, DEVICE_COOKIE));
}

/** True when the request carries an unexpired `__Host-tsv` bound to its own `__Host-did`. */
export async function hasChallengePass(request: Request, now = Date.now()): Promise<boolean> {
  const deviceId = requestDeviceId(request);
  if (!deviceId) return false;
  return hasTurnstilePass(readCookie(request.headers, TURNSTILE_PASS_COOKIE), binding(deviceId), now);
}

/**
 * Set-Cookie value of a fresh pass for `deviceId` (30 minutes). SameSite=Lax: a visitor who comes
 * back from a search engine or another site still presents it on that first page view.
 */
export async function challengePassCookie(deviceId: string, now = Date.now()): Promise<string> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId)) throw new Error("challengePassCookie: invalid device id");
  const value = turnstilePass(binding(deviceId), now);
  return `${TURNSTILE_PASS_COOKIE}=${value}; Path=/; Max-Age=${TURNSTILE_PASS_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}
