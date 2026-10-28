// Cookie consent store (phase 6, D1): first-party cookie `jt_consent`, written by the browser,
// value `1.<base64url JSON {v, t, ads, perso}>`. Missing, expired, older `v` or unreadable = no
// choice yet. No server-side log per visitor: the proof is the versioned banner code (CNIL).

export const CONSENT_COOKIE = "jt_consent";
/** Schema version of the choice: raising it asks every visitor again. */
export const CONSENT_VERSION = 1;
/** Six months (CNIL: a choice is kept, then asked again, after about six months). */
export const CONSENT_MAX_AGE_S = 182 * 24 * 60 * 60;

export interface ConsentChoice {
  /** AdSense ad storage and measurement (data sent to Google LLC, United States). */
  ads: boolean;
  /** Ad personalisation and ad user data; never without `ads`. */
  perso: boolean;
  /** When the choice was made, epoch seconds. */
  t: number;
}

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
}

/** A choice with personalisation only under ads (the panel enforces it too). */
export function normalizeChoice(ads: boolean, perso: boolean, t: number): ConsentChoice {
  return { ads, perso: ads && perso, t: Math.floor(t) };
}

export function serializeConsent(choice: ConsentChoice): string {
  return `${CONSENT_VERSION}.${toBase64Url(JSON.stringify({ v: CONSENT_VERSION, t: choice.t, ads: choice.ads, perso: choice.perso }))}`;
}

/**
 * The stored choice, or null when there is none to honour (missing, older version, expired,
 * malformed). Without `nowS` the dates are not checked (a value already validated once).
 */
export function parseConsent(raw: string | undefined, nowS?: number): ConsentChoice | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 1 || raw.slice(0, dot) !== String(CONSENT_VERSION)) return null;
  try {
    const value: unknown = JSON.parse(fromBase64Url(raw.slice(dot + 1)));
    if (typeof value !== "object" || value === null) return null;
    const { v, t, ads, perso } = value as Record<string, unknown>;
    if (v !== CONSENT_VERSION || typeof t !== "number" || !Number.isFinite(t) || typeof ads !== "boolean" || typeof perso !== "boolean") return null;
    // A future date (clock change, tampering) or one past six months is no choice.
    if (nowS !== undefined && (t > nowS + 24 * 60 * 60 || nowS - t > CONSENT_MAX_AGE_S)) return null;
    return normalizeChoice(ads, perso, t);
  } catch {
    return null;
  }
}

/** `jt_consent` among the cookies of `document.cookie`. */
export function readConsentCookie(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CONSENT_COOKIE) return rest.join("=");
  }
  return undefined;
}

/** The `document.cookie` assignment that stores a choice; `Secure` except on plain-HTTP development. */
export function consentCookieString(choice: ConsentChoice, secure: boolean): string {
  return `${CONSENT_COOKIE}=${serializeConsent(choice)}; Max-Age=${CONSENT_MAX_AGE_S}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}
