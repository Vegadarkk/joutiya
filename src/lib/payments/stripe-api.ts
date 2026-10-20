import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

// Minimal Stripe REST client (phase 7 design §7): form-encoded calls with the pinned API version,
// an idempotency key on creations and a 10 s timeout, plus the webhook signature check
// (`Stripe-Signature: t=..,v1=..`, HMAC-SHA256 of `{t}.{raw body}`, 5-minute tolerance). No SDK:
// the app calls a handful of endpoints (Customers, Checkout Sessions, Customer Portal, Invoices).

export const STRIPE_API_VERSION = "2026-09-30.endive";
const API_ORIGIN = "https://api.stripe.com";
const TIMEOUT_MS = 10_000;
/** Seconds a signed delivery stays valid (Stripe's default tolerance). */
export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

/** A failed call; `retryable` when a later attempt may succeed (rate limit, lock, 5xx, network). */
export class StripeApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

export function isStripeConfigured(env: { STRIPE_SECRET_KEY?: string } = serverEnv()): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export type StripeParam = string | number | boolean | undefined | null | readonly StripeParam[] | { readonly [key: string]: StripeParam };

/** Stripe's bracket notation (`a[b][0][c]=v`); undefined and null values are left out. */
export function formEncode(params: Readonly<Record<string, StripeParam>>): string {
  const pairs: [string, string][] = [];
  const walk = (key: string, value: StripeParam): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item: StripeParam, index) => walk(`${key}[${index}]`, item));
    else if (typeof value === "object") for (const [name, item] of Object.entries(value as Record<string, StripeParam>)) walk(`${key}[${name}]`, item);
    else pairs.push([key, String(value)]);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return new URLSearchParams(pairs).toString();
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

export async function stripeRequest<T>(method: "GET" | "POST", path: string, params: Readonly<Record<string, StripeParam>> = {}, options: StripeRequestOptions = {}): Promise<T> {
  const key = serverEnv().STRIPE_SECRET_KEY;
  if (!key) throw new StripeApiError(null, false, undefined, "STRIPE_SECRET_KEY is not set");
  const encoded = formEncode(params);
  const url = new URL(path, API_ORIGIN);
  if (method === "GET" && encoded) url.search = encoded;
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION, accept: "application/json" };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { method, headers, ...(method === "POST" ? { body: encoded } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new StripeApiError(null, true, undefined, `Stripe API unreachable: ${(error as Error).name}`);
  }
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  if (!response.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code.slice(0, 64) : undefined;
    // 409: an idempotent request still running; Stripe's message is not kept (it may quote the request).
    throw new StripeApiError(response.status, [409, 429].includes(response.status) || response.status >= 500, code, `Stripe API answered ${response.status}${code ? ` (${code})` : ""}`);
  }
  if (body === null) throw new StripeApiError(response.status, false, undefined, "Stripe API answered an unexpected body");
  return body as T;
}

/** True when `header` signs `payload` with `secret` within the tolerance. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, nowMs = Date.now(), toleranceS = STRIPE_SIGNATURE_TOLERANCE_S): boolean {
  if (!header || header.length > 2_000) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (name === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === undefined || Math.abs(nowMs / 1_000 - timestamp) > toleranceS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex"));
  return signatures.some((signature) => timingSafeEqual(Buffer.from(signature), expected));
}
