import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

// Keyed hashes of identifiers (§6 "Journaux"): IPs, devices and normalized e-mails are never
// stored or used as keys in clear, except where the law requires it (connectionLogs, contentOps).

/** Development fallback: deployed environments refuse to start without HASH_PEPPER (src/lib/env.ts). */
const DEV_PEPPER = "joutiya-dev-pepper-not-a-secret-0000";

export function hmacBase64Url(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** HMAC of `value` under HASH_PEPPER, domain-separated by `purpose` ("ip", "email", "device"...). */
export function pepperedHash(purpose: string, value: string): string {
  return hmacBase64Url(serverEnv().HASH_PEPPER ?? DEV_PEPPER, `${purpose}:${value}`);
}

/** Constant-time comparison of two strings (false when the lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
