import { LOCALES, type Locale } from "@/config/site";
import { safeNextPath } from "@/lib/auth/next-path";

// Page challenge of the SSR limits (design D14): the proxy sends a visitor over the limits to
// /{locale}/anti-robot?next=<path>; once solved, the page returns to `next`. No server import: shared
// by proxy.ts, the page and its client component.

export const CHALLENGE_SEGMENT = "anti-robot";
const NEXT_MAX = 1024;
const LOCALE_PREFIX = new RegExp(`^/(${LOCALES.join("|")})(?=/|\\?|$)`);

export function challengeUrlPath(locale: Locale, next: string): string {
  return `/${locale}/${CHALLENGE_SEGMENT}?next=${encodeURIComponent(next)}`;
}

/**
 * The page to return to: a same-site page path with a locale prefix (never an API route, an
 * absolute or protocol-relative URL, or the challenge page itself), else the home page of `locale`.
 */
export function challengeNext(value: string | null | undefined, locale: Locale): string {
  const fallback = `/${locale}`;
  const safe = safeNextPath(value);
  if (!safe || safe.length > NEXT_MAX || !LOCALE_PREFIX.test(safe)) return fallback;
  const segment = safe.split(/[/?#]/)[2] ?? "";
  return segment === CHALLENGE_SEGMENT ? fallback : safe;
}
