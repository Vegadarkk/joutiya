import "server-only";
import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/auth/guards";
import { serverEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import { readCookie } from "@/lib/http/cookies";
import type { RequestIdentity } from "@/lib/rate-limit/keys";
import { TURNSTILE_PASS_COOKIE } from "@/lib/security/cookies";
import { hasTurnstilePass, verifyTurnstile, type TurnstileAction } from "@/lib/security/turnstile";
import { applyDevice, applyTurnstilePass, deviceOf, jsonResponse, type Device } from "./respond";

// Anonymous mutations (sign-up, login, reset...): same-origin check, rate-limit identity, Turnstile
// with its 30-minute pass, device cookie on the way out (§6 "Les clés", "Anti-robots").

const flows = new WeakMap<Request, AnonymousFlow>();

export interface AnonymousFlow {
  device: Device;
  identity: RequestIdentity;
  userAgent: string | undefined;
  /** Whether this request passed a Turnstile check: the response then carries the pass cookie. */
  turnstilePassed: boolean;
}

/** User agent for connectionLogs (schema: 200 characters at most). */
export function userAgentOf(request: Request): string | undefined {
  const value = request.headers.get("user-agent")?.trim();
  return value ? value.slice(0, 200) : undefined;
}

/** Origin must be this host's; the request's identity and device cookie are prepared. */
export function beginAnonymous(request: Request): AnonymousFlow {
  requireSameOrigin(request);
  const device = deviceOf(request);
  const flow: AnonymousFlow = { device, identity: device.identity, userAgent: userAgentOf(request), turnstilePassed: false };
  flows.set(request, flow);
  return flow;
}

/**
 * Wraps an anonymous handler so that its HttpError answers (401 invalid_credentials, 429...) also
 * carry the device and Turnstile pass cookies: a wrong password after a solved challenge must not
 * lose the pass, and the device gets its cookie on the first answer whatever it is.
 */
export function anonymous(run: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await run(request);
    } catch (error) {
      const flow = flows.get(request);
      if (!(error instanceof HttpError) || !flow) throw error;
      const plain = error.toResponse();
      return finish(flow, new NextResponse(plain.body, { status: plain.status, headers: plain.headers }));
    }
  };
}

/** 403 `turnstile_failed` unless the widget token checks out for `action` on this site. */
export async function checkTurnstile(flow: AnonymousFlow, token: string | undefined, action: TurnstileAction): Promise<void> {
  const result = await verifyTurnstile(token, { action, remoteIp: flow.identity.ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!result.ok) throw new HttpError(403, "turnstile_failed", undefined, { details: { codes: result.codes } });
  flow.turnstilePassed = true;
}

/** A valid __Host-tsv pass bound to this device lifts the escalation (§6). */
export function hasPass(flow: AnonymousFlow, request: Request): boolean {
  return hasTurnstilePass(readCookie(request.headers, TURNSTILE_PASS_COOKIE), flow.identity.deviceKey);
}

/** Device and Turnstile pass cookies on a response built elsewhere. */
export function finish<T>(flow: AnonymousFlow, response: NextResponse<T>): NextResponse<T> {
  applyDevice(response, flow.device);
  if (flow.turnstilePassed) applyTurnstilePass(response, flow.device);
  return response;
}

export function respond<T>(flow: AnonymousFlow, body: T, init: ResponseInit = {}): NextResponse<T> {
  return finish(flow, jsonResponse(body, init));
}
