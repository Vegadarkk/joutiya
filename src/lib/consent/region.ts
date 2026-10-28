// Visitor region for the consent rules (phase 6, D5): Cloudflare's same-origin `/cdn-cgi/trace`
// (free on proxied zones, no CSP change) gives `loc=XX`. Unknown counts as EEA/UK/CH, the
// stricter case.

/** EEA (EU 27, Iceland, Liechtenstein, Norway), United Kingdom and Switzerland. */
export const EEA_UK_CH: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH",
]);

/** The `loc` line of a trace body, upper case, or null. */
export function traceCountry(body: string): string | null {
  const match = /^loc=([A-Za-z]{2})$/m.exec(body);
  return match ? match[1]!.toUpperCase() : null;
}

/** True for an EEA/UK/CH country, and for an unknown one. */
export function isEeaUkCh(country: string | null): boolean {
  return country === null || EEA_UK_CH.has(country);
}

let pending: Promise<string | null> | undefined;

/** The visitor's country from Cloudflare, once per page load; null when unavailable (development, error). */
export function visitorCountry(): Promise<string | null> {
  pending ??= fetch("/cdn-cgi/trace", { credentials: "omit" })
    .then((response) => (response.ok ? response.text() : ""))
    .then(traceCountry, () => null);
  return pending;
}
