import "server-only";
import { optionalUser } from "@/lib/auth/guards";
import { TURNSTILE_HEADER } from "@/lib/contracts/search";
import { serverEnv } from "@/lib/env";
import { HttpError, rateLimited } from "@/lib/http/errors";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { consumeLimit, type LimitOutcome } from "@/lib/rate-limit/limiter";
import { assertChallengeBudget, recordChallengeFailure } from "@/lib/security/challenge-handler";
import { hasChallengePass } from "@/lib/security/challenge-pass";
import { verifyTurnstile, type TurnstileAction } from "@/lib/security/turnstile";

// Search limits (§6, design D13), shared by GET /api/search and the /recherche page: per device
// (per account when signed in) 30 a minute and 600 an hour, per IP 120 a minute (IPv6: also 1 200
// a minute per /48). Over any of them,
// a valid `__Host-tsv` pass allows `search.passed.device` more, then 429; without a pass the caller
// must solve Turnstile (403 `turnstile_required`) and retry with the token in `x-turnstile-token`.
// Every limiter is "open": valkey-ratelimit down never blocks searching.

export const SEARCH_TURNSTILE_ACTION: TurnstileAction = "search";

const isLimited = (outcome: LimitOutcome): boolean => !outcome.ok && outcome.reason === "limited";

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
    ...(identity.ip48 ? [consumeLimit("search.ip48", identity.ip48)] : []),
  ]);
  if (!outcomes.some(isLimited)) return { passGranted: false };

  if (await hasChallengePass(request)) {
    const passed = await consumeLimit("search.passed.device", subject);
    if (!passed.ok && passed.reason === "limited") throw rateLimited(passed.retryAfterSeconds);
    return { passGranted: false };
  }

  const token = request.headers.get(TURNSTILE_HEADER)?.trim();
  if (!token) throw new HttpError(403, "turnstile_required");
  // Failed checks share their budgets with the page challenge (/anti-robot); solved ones cost nothing.
  await assertChallengeBudget(identity);
  const result = await verifyTurnstile(token, { action: SEARCH_TURNSTILE_ACTION, remoteIp: identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!result.ok) {
    await recordChallengeFailure(identity, result.codes);
    throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: result.codes } });
  }
  return { passGranted: true };
}
