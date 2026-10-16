import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/security/hash";

// Authentication of the RevenueCat webhook (phase-7/research/revenuecat.md §4). Both checks run:
// the static `Authorization` value set in the RevenueCat dashboard, and the opt-in HMAC signature
// `X-RevenueCat-Webhook-Signature: t=<unix seconds>,v1=<hex>` = HMAC-SHA256 of "<t>.<raw body>"
// under the integration signing secret, with a freshness window. RevenueCat recomputes `t` and
// `v1` on every delivery attempt, so retries pass the window.

export const SIGNATURE_HEADER = "x-revenuecat-webhook-signature";
/** Accepted clock skew between RevenueCat's `t` and our clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

/** `t=...,v1=...[,v1=...]`; null when malformed. */
export function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export function expectedSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(Buffer.from(rawBody, "utf8")).digest("hex");
}

export type WebhookAuthFailure = "authorization" | "signature_missing" | "signature_stale" | "signature_mismatch" | "not_configured";

/** Null when the delivery is authentic, else the reason (logged, never echoed to the caller). */
export function authenticateWebhook(input: {
  rawBody: string;
  authorization: string | null;
  signature: string | null;
  expectedAuthorization: string;
  signingSecret: string;
  now: Date;
}): WebhookAuthFailure | null {
  if (!input.expectedAuthorization || !input.signingSecret) return "not_configured";
  if (!input.authorization || !safeEqual(input.authorization, input.expectedAuthorization)) return "authorization";
  const parsed = parseSignatureHeader(input.signature);
  if (!parsed) return "signature_missing";
  if (Math.abs(input.now.getTime() / 1000 - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return "signature_stale";
  const expected = expectedSignature(input.signingSecret, parsed.timestamp, input.rawBody);
  return parsed.signatures.some((candidate) => safeEqual(candidate, expected)) ? null : "signature_mismatch";
}
