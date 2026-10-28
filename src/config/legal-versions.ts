import type { LegalSlug } from "./legal-pages";

// Version and effective date of each legal page (phase 6, D11), printed at the top of the page
// ({version}, {effectiveDate}). A change to the CGU, the privacy policy or the cookie policy bumps
// its entry; the CGU notice of D11 compares the accepted version with `LEGAL_VERSIONS.cgu`. The
// launch checklist moves every effective date to the opening day (spec §10).

export interface LegalVersion {
  version: string;
  /** ISO date, Africa/Casablanca. */
  effective: string;
  /**
   * CGU only: earlier recorded versions this text replaces without notice (same text). Members who
   * accepted one of them get neither the banner nor the e-mail of a CGU change.
   */
  replaces?: readonly string[];
}

export const LEGAL_VERSIONS: Record<LegalSlug, LegalVersion> = {
  // "2026-10": the version sign-up recorded before the texts were versioned (same text).
  cgu: { version: "1.0", effective: "2026-10-28", replaces: ["2026-10"] },
  "referencement-et-classement": { version: "1.0", effective: "2026-10-28" },
  cgv: { version: "0.1", effective: "2026-10-20" },
  confidentialite: { version: "1.0", effective: "2026-10-28" },
  cookies: { version: "1.0", effective: "2026-10-28" },
  "droits-et-obligations": { version: "1.0", effective: "2026-10-28" },
  "avis-utilisateurs": { version: "1.0", effective: "2026-10-28" },
  "confiance-et-securite": { version: "1.0", effective: "2026-10-28" },
  "paiement-en-plusieurs-fois": { version: "1.0", effective: "2026-10-28" },
  "mentions-legales": { version: "1.0", effective: "2026-10-28" },
  "contact-autorites": { version: "1.0", effective: "2026-10-28" },
  "objets-interdits": { version: "1.0", effective: "2026-10-28" },
};

/** Pages whose Arabic text exists; the others show the French text on the Arabic site. */
export const ARABIC_LEGAL_PAGES: ReadonlySet<LegalSlug> = new Set(
  (Object.keys(LEGAL_VERSIONS) as LegalSlug[]).filter((slug) => slug !== "cgv"),
);

/** Pages still provisional (D11): the CGV until the sales gate (phase 7). */
export const PROVISIONAL_LEGAL_PAGES: ReadonlySet<LegalSlug> = new Set<LegalSlug>(["cgv"]);

/** True when a recorded CGU acceptance covers the current CGU (no change notice due). */
export function cguAccepted(stored: string | undefined): boolean {
  const current = LEGAL_VERSIONS.cgu;
  return stored === current.version || (stored !== undefined && (current.replaces ?? []).includes(stored));
}
