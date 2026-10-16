import "server-only";
import { randomInt } from "node:crypto";
import { pepperedHash } from "@/lib/security/hash";

// One-time codes of the WhatsApp verification (§6): 6 digits, stored only as a peppered HMAC
// bound to the account. Phone numbers never appear in clear in Valkey keys either.

/** 6-digit code, uniformly drawn (100000..999999). */
export function newCode(): string {
  return String(randomInt(100000, 1000000));
}

/** Hash stored for a challenge: binds the code to the account that started it. */
export function codeHash(uid: string, code: string): string {
  return pepperedHash("pv", `${uid}:${code}`);
}

/** Key material of the phone -> uid pointer. */
export function phoneKey(e164: string): string {
  return pepperedHash("pvp", e164);
}

/** Key material of the (phone, code) -> uid index: the code in the message picks the challenge. */
export function phoneCodeKey(e164: string, code: string): string {
  return pepperedHash("pvc", `${e164}:${code}`);
}
