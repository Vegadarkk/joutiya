import { ApiError, type ApiErrorCode } from "@/lib/auth/client";

// Pure helpers of the phone reveal island, shared by the contact bar and its on-demand feedback.

/** Reveal refusals with a message of their own (src/lib/listings/phone-reveal.ts, escalation.ts, limiter). */
export const REVEAL_ERROR_KEYS = ["reveal_not_allowed", "listing_unavailable", "not_found", "turnstile_required", "turnstile_failed", "rate_limited", "unavailable", "network"] as const;
export type RevealErrorKey = (typeof REVEAL_ERROR_KEYS)[number];

/**
 * What the island does with a failed reveal: `signin` (session gone), one of the reveal messages,
 * or `null` for the generic API message (account suspended, internal error).
 */
export function revealFailure(error: unknown): "signin" | RevealErrorKey | null {
  const code: ApiErrorCode = error instanceof ApiError ? error.code : "internal";
  if (code === "unauthenticated") return "signin";
  // Both escalation answers share one message (shown only when the challenge cannot help).
  if (code === "turnstile_failed") return "turnstile_required";
  return (REVEAL_ERROR_KEYS as readonly string[]).includes(code) ? (code as RevealErrorKey) : null;
}

/** The API builds `https://wa.me/<digits>`; anything else is never turned into a link. */
export function isWhatsappUrl(url: string): boolean {
  return /^https:\/\/wa\.me\/\d{8,15}$/.test(url);
}
