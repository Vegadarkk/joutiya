import "server-only";
import type { IpRateLimitId } from "@/config/rate-limits";
import type { Device } from "@/lib/auth/respond";
import { serverEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import { readCookie } from "@/lib/http/cookies";
import { assertIpLimit, consumeIpLimit } from "@/lib/rate-limit/limiter";
import { TURNSTILE_PASS_COOKIE } from "@/lib/security/cookies";
import { hasTurnstilePass, verifyTurnstile, type TurnstileAction } from "@/lib/security/turnstile";

// IP limiter with Turnstile escalation (§6 "une IP n'est jamais bloquée net"), the phase 2 login
// pattern for signed-in routes: past the IP allowance the request needs a Turnstile token (403
// `turnstile_required`), unless the device holds a recent pass. A solved challenge returns true so
// the response sets the 30-minute pass cookie. The store being down follows the limiter's policy.
// The allowance holds on the IP /64 and, for IPv6, on its /48 (limiter.ts consumeIpLimit).

export async function escalateOnIp(request: Request, id: IpRateLimitId, device: Device, token: string | undefined, action: TurnstileAction): Promise<boolean> {
  const outcome = await consumeIpLimit(id, device.identity);
  if (outcome.ok) return false;
  if (outcome.reason === "unavailable") {
    assertIpLimit(id, outcome);
    return false;
  }
  if (hasTurnstilePass(readCookie(request.headers, TURNSTILE_PASS_COOKIE), device.identity.deviceKey)) return false;
  if (!token) throw new HttpError(403, "turnstile_required");
  const result = await verifyTurnstile(token, { action, remoteIp: device.identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!result.ok) throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: result.codes } });
  return true;
}
