import { LOCALES, type Locale } from "@/config/site";

// `?next=` targets of the sign-in flow (set by the account layout guard and the header link). One
// check for the server pages, the client store and the hooks: no "use client", no server import.

const LOCALE_PREFIX = new RegExp(`^/(${LOCALES.join("|")})(?=/|\\?|#|$)`);

/** Where a sign-in lands when `next` is absent or refused. */
export const DEFAULT_AFTER_SIGN_IN = "/parametres";

/**
 * A `?next=` value is followed only when it is a same-origin relative path: exactly one leading
 * slash (`//evil` is protocol-relative), hence no scheme, no backslash (browsers turn `\` into `/`),
 * no control character.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export interface NextTarget {
  /** Path without its locale prefix (what the i18n router and `Link` expect). */
  pathname: string;
  /** Locale named by the prefix of `next`, or null to keep the current one. */
  locale: Locale | null;
}

/** A safe `next` split into its locale prefix (when it has one) and the locale-free path. */
export function splitNextPath(next: string): NextTarget {
  const match = LOCALE_PREFIX.exec(next);
  if (!match) return { locale: null, pathname: next };
  // "/fr" -> "/", "/fr?q=1" -> "/?q=1", "/fr/x" -> "/x".
  const rest = next.slice(match[0].length);
  return { locale: match[1] as Locale, pathname: rest.startsWith("/") ? rest : `/${rest}` };
}

/** The page a signed-in person goes to: the safe `next` (its own locale honoured) or the settings page. */
export function afterSignInTarget(next: string | string[] | null | undefined): NextTarget {
  const safe = safeNextPath(Array.isArray(next) ? next[0] : next);
  return safe ? splitNextPath(safe) : { locale: null, pathname: DEFAULT_AFTER_SIGN_IN };
}
