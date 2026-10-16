import "server-only";
import { NextResponse } from "next/server";
import { RATE_LIMITS } from "@/config/rate-limits";
import { challengePassSchema } from "@/lib/contracts/search";
import { serverEnv } from "@/lib/env";
import { HttpError, rateLimited } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { consumeLimit, limitState } from "@/lib/rate-limit/limiter";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { challengePassCookie } from "./challenge-pass";
import { setDeviceCookie } from "./cookies";
import { newDeviceCookie } from "./device";
import { hostKind, isSameOrigin } from "./origin";
import { verifyTurnstile } from "./turnstile";

// POST /api/challenge/pass (design D14): the /anti-robot page posts its Turnstile token (action
// "pages"); a valid one sets the 30-minute `__Host-tsv` pass bound to the device. No session: the
// Origin check stands in for CSRF (the pass only lifts limits). `challenge.ip` counts failed checks,
// shared with the search challenge (search/limits.ts): past it, 429 without a siteverify call.
// Solved checks cost nothing, so a carrier-grade NAT full of real people is never locked out.

export async function handleChallengePass(request: Request): Promise<Response> {
  if (!isSameOrigin(request.headers, hostKind(request.headers))) throw new HttpError(403, "origin", "missing or foreign Origin");
  const { token } = await readJson(request, challengePassSchema);
  const identity = requestIdentity(request.headers);
  const budget = await limitState("challenge.ip", identity.ipBucket);
  if (budget && budget.consumedPoints >= RATE_LIMITS["challenge.ip"].points) throw rateLimited(budget.msBeforeNext / 1000);
  const result = await verifyTurnstile(token, { action: "pages", remoteIp: identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!result.ok) {
    await consumeLimit("challenge.ip", identity.ipBucket);
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
