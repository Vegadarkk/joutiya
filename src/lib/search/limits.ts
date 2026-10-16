import "server-only";
import { RATE_LIMITS } from "@/config/rate-limits";
import { optionalUser } from "@/lib/auth/guards";
import { TURNSTILE_HEADER } from "@/lib/contracts/search";
import { serverEnv } from "@/lib/env";
import { HttpError, rateLimited } from "@/lib/http/errors";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { consumeLimit, limitState, type LimitOutcome } from "@/lib/rate-limit/limiter";
import { hasChallengePass } from "@/lib/security/challenge-pass";
import { verifyTurnstile, type TurnstileAction } from "@/lib/security/turnstile";

// Search limits (§6, design D13), shared by GET /api/search and the /recherche page: per device
// (per account when signed in) 30 a minute and 600 an hour, per IP 120 a minute. Over any of them,
// a valid `__Host-tsv` pass allows `search.passed.device` more, then 429; without a pass the caller
// must solve Turnstile (403 `turnstile_required`) and retry with the token in `x-turnstile-token`.
// Every limiter is "open": valkey-ratelimit down never blocks searching.

export const SEARCH_TURNSTILE_ACTION: TurnstileAction = "search";

const isLimited = (outcome: LimitOutcome): boolean => !outcome.ok && outcome.reason === "limited";

/**
 * Failed token checks share `challenge.ip` with the page challenge (/anti-robot): past its budget a
 * client sending bad tokens gets a plain 429 without a new siteverify call. Solved checks cost nothing.
 */
async function assertVerificationBudget(ipBucket: string): Promise<void> {
  const state = await limitState("challenge.ip", ipBucket);
  if (state && state.consumedPoints >= RATE_LIMITS["challenge.ip"].points) throw rateLimited(state.msBeforeNext / 1000);
}

/**
 * Consumes the search limits of `request`. Resolves `{ passGranted: true }` when this request
 * solved the challenge: the response must then set `challengePassCookie(deviceId)`. Throws 403
 * `turnstile_required` / `turnstile_failed` or 429.
 */
export async function enforceSearchLimit(request: Request): Promise<{ passGranted: boolean }> {
  const identity = requestIdentity(request.headers);
  // Local signature check only (no revocation lookup); an invalid cookie counts as the device.
  const viewer = await optionalUser(request);
  const subject = viewer ? `u:${viewer.user.uid}` : identity.deviceKey;
  const outcomes = await Promise.all([
    consumeLimit("search.device.minute", subject),
    consumeLimit("search.device.hour", subject),
    consumeLimit("search.ip", identity.ipBucket),
  ]);
  if (!outcomes.some(isLimited)) return { passGranted: false };

  if (await hasChallengePass(request)) {
    const passed = await consumeLimit("search.passed.device", subject);
    if (!passed.ok && passed.reason === "limited") throw rateLimited(passed.retryAfterSeconds);
    return { passGranted: false };
  }

  const token = request.headers.get(TURNSTILE_HEADER)?.trim();
  if (!token) throw new HttpError(403, "turnstile_required");
  await assertVerificationBudget(identity.ipBucket);
  const result = await verifyTurnstile(token, { action: SEARCH_TURNSTILE_ACTION, remoteIp: identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!result.ok) {
    await consumeLimit("challenge.ip", identity.ipBucket);
    throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: result.codes } });
  }
  return { passGranted: true };
}
