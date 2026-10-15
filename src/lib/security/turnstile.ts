import "server-only";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { TURNSTILE_PASS_SECONDS } from "./cookies";
import { pepperedHash, safeEqual } from "./hash";

// Turnstile (§2 "Anti-robots", §6): server-side check of the widget token. Fail closed: a network
// error or a timeout is a failed check. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileAction = "signup" | "login" | "reset" | "google" | "verify-resend" | "staff-login";

export interface TurnstileResult {
  ok: boolean;
  codes: string[];
}

export interface TurnstileCheck {
  remoteIp?: string;
  action: TurnstileAction;
  /** Hostname the widget must have been solved on (the request's host). */
  hostname?: string;
}

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export async function verifyTurnstile(token: string | undefined, check: TurnstileCheck, fetchImpl: typeof fetch = fetch): Promise<TurnstileResult> {
  const env = serverEnv();
  if (!env.TURNSTILE_SECRET_KEY) {
    // Development without keys only: deployed environments refuse to start without them.
    return env.APP_ENV === "dev" ? { ok: true, codes: ["dev-bypass"] } : { ok: false, codes: ["not-configured"] };
  }
  if (!token || token.length > 2048) return { ok: false, codes: ["missing-input-response"] };
  try {
    const response = await fetchImpl(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(check.remoteIp ? { remoteip: check.remoteIp } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, codes: [`http-${response.status}`] };
    const result = (await response.json()) as SiteverifyResponse;
    const codes = Array.isArray(result["error-codes"]) ? result["error-codes"].filter((code) => typeof code === "string") : [];
    if (result.success !== true) return { ok: false, codes };
    if (result.action !== undefined && result.action !== check.action) return { ok: false, codes: ["action-mismatch"] };
    if (check.hostname && result.hostname !== undefined && result.hostname !== check.hostname) return { ok: false, codes: ["hostname-mismatch"] };
    return { ok: true, codes: [] };
  } catch (error) {
    logger.warn({ err: (error as Error).name }, "turnstile: siteverify unreachable");
    return { ok: false, codes: ["unreachable"] };
  }
}

/** Value of the __Host-tsv cookie: a pass bound to the device (or IP bucket), valid 30 minutes. */
export function turnstilePass(binding: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + TURNSTILE_PASS_SECONDS;
  return `${expires}.${pepperedHash("tsv", `${expires}:${binding}`).slice(0, 32)}`;
}

export function hasTurnstilePass(value: string | undefined, binding: string, now = Date.now()): boolean {
  if (!value) return false;
  const [expires, sig] = value.split(".");
  if (!expires || !sig || !/^\d{10}$/.test(expires) || Number(expires) * 1000 < now) return false;
  return safeEqual(pepperedHash("tsv", `${expires}:${binding}`).slice(0, 32), sig);
}
