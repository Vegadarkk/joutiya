import "server-only";
import { NextResponse } from "next/server";
import { RATE_LIMITS } from "@/config/rate-limits";
import { challengePassSchema } from "@/lib/contracts/search";
import { serverEnv } from "@/lib/env";
import { HttpError, rateLimited } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { consumeLimit, limitState } from "@/lib/rate-limit/limiter";
import { requestIdentity, type RequestIdentity } from "@/lib/rate-limit/keys";
import { challengePassCookie } from "./challenge-pass";
import { setDeviceCookie } from "./cookies";
import { newDeviceCookie } from "./device";
import { hostKind, isSameOrigin } from "./origin";
import { verifyTurnstile } from "./turnstile";

// POST /api/challenge/pass (design D14): the /anti-robot page posts its Turnstile token (action
// "pages"); a valid one sets the 30-minute `__Host-tsv` pass bound to the device. No session: the
// Origin check stands in for CSRF (the pass only lifts limits).
//
// Failed checks, shared with the search challenge (search/limits.ts), count per device
// (`challenge.device`) and per IP (`challenge.ip`, `challenge.ip.hard`); past a ceiling, 429
// without a siteverify call. The IP ceiling only holds against a device that already failed: an
// IPv4 behind a carrier-grade NAT is shared by strangers, and one of them sending junk tokens must
// not cheaply refuse the others a valid solve. A client minting a fresh device cookie for every
// junk token never meets it; the hard IP ceiling (5x) bounds that one, for every device.

/** Throws 429 when this client spent its failed checks (none spent: always checked). */
export async function assertChallengeBudget(identity: RequestIdentity): Promise<void> {
  const [device, ip, hard] = await Promise.all([
    limitState("challenge.device", identity.deviceKey),
    limitState("challenge.ip", identity.ipBucket),
    limitState("challenge.ip.hard", identity.ipBucket),
  ]);
  if (hard && hard.consumedPoints >= RATE_LIMITS["challenge.ip.hard"].points) throw rateLimited(hard.msBeforeNext / 1000);
  if (!device) return;
  if (device.consumedPoints >= RATE_LIMITS["challenge.device"].points) throw rateLimited(device.msBeforeNext / 1000);
  if (device.consumedPoints > 0 && ip && ip.consumedPoints >= RATE_LIMITS["challenge.ip"].points) throw rateLimited(ip.msBeforeNext / 1000);
}

/** Counts a refused token. siteverify unreachable or failing is not the client's failure. */
export async function recordChallengeFailure(identity: RequestIdentity, codes: readonly string[]): Promise<void> {
  if (codes.some((code) => code === "unreachable" || code.startsWith("http-"))) return;
  await Promise.all([
    consumeLimit("challenge.device", identity.deviceKey),
    consumeLimit("challenge.ip", identity.ipBucket),
    consumeLimit("challenge.ip.hard", identity.ipBucket),
  ]);
}

export async function handleChallengePass(request: Request): Promise<Response> {
  if (!isSameOrigin(request.headers, hostKind(request.headers))) throw new HttpError(403, "origin", "missing or foreign Origin");
  const { token } = await readJson(request, challengePassSchema);
  const identity = requestIdentity(request.headers);
  await assertChallengeBudget(identity);
  const result = await verifyTurnstile(token, { action: "pages", remoteIp: identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!result.ok) {
    await recordChallengeFailure(identity, result.codes);
    throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: result.codes } });
  }

  // The page is private, so the proxy gave it a device cookie; a client without one gets it here.
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  let deviceId = identity.deviceId;
  if (!deviceId) {
    const fresh = newDeviceCookie();
    setDeviceCookie(response, fresh.value);
    deviceId = fresh.id;
  }
  response.headers.append("Set-Cookie", await challengePassCookie(deviceId));
  return response;
}
