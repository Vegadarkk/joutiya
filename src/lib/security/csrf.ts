import "server-only";
import { serverEnv } from "@/lib/env";
import { hmacBase64Url, safeEqual } from "./hash";

// Signed double submit (§6): the token is an HMAC of the session cookie under CSRF_SECRET. It is
// set in a readable __Host- cookie and must come back in the X-CSRF-Token header of every
// authenticated mutation, on top of the mandatory Origin check (src/lib/security/origin.ts).

const DEV_SECRET = "joutiya-dev-csrf-secret-not-a-secret";

export function csrfToken(session: string): string {
  return hmacBase64Url(serverEnv().CSRF_SECRET ?? DEV_SECRET, `csrf:${session}`);
}

export function isValidCsrf(session: string | undefined, header: string | null): boolean {
  if (!session || !header) return false;
  return safeEqual(csrfToken(session), header);
}
