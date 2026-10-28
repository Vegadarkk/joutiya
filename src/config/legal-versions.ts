import type { LegalSlug } from "./legal-pages";

// Version and effective date of each legal page (phase 6, D11), printed at the top of the page
// ({version}, {effectiveDate}). A change to the CGU, the privacy policy or the cookie policy bumps
// its entry; the CGU notice of D11 compares the accepted version with `LEGAL_VERSIONS.cgu`. The
// launch checklist moves every effective date to the opening day (spec §10).

export interface LegalVersion {
  version: string;
  /** ISO date, Africa/Casablanca. */
  effective: string;
}

export const LEGAL_VERSIONS: Record<LegalSlug, LegalVersion> = {
  cgu: { version: "1.0", effective: "2026-10-28" },
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
