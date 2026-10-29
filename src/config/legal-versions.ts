import type { LegalSlug } from "./legal-pages";

// Version and effective date of each legal page (phase 6, D11), printed at the top of the page
// ({version}, {effectiveDate}). A change to the CGU, the privacy policy or the cookie policy bumps
// its entry; the CGU notice of D11 compares the accepted version with `LEGAL_VERSIONS.cgu`. Before
// the launch the texts change without a bump: the launch reset (spec §10, scripts/launch-check.ts)
// sets every page to "1.0" on the opening day and freezes the texts (LEGAL_TEXTS_FROZEN), after
// which tests/unit/legal-versions.test.ts refuses a text change without a new version.

export interface LegalVersion {
  version: string;
  /** ISO date, Africa/Casablanca. */
  effective: string;
  /**
   * CGU only: earlier recorded versions this text replaces without notice (same text). Members who
   * accepted one of them get neither the banner nor the e-mail of a CGU change.
   */
  replaces?: readonly string[];
  /**
   * CGU after "1.0" (CGU §22.1): the day the change is announced (ISO), when the banner and the
   * e-mails start. `effective` is at least 30 days later, unless `urgent` (CGU §22.2).
   */
  announced?: string;
  /** CGU §22.2: a shorter notice, required by law or an authority, or against an imminent danger. */
  urgent?: true;
  /** CGU after "1.0": what changes, a few short lines, shown in the banner and the e-mail. */
  summary?: Readonly<Record<"fr" | "ar", readonly string[]>>;
}

/** Version of every legal page on the opening day (spec §10). */
export const LAUNCH_LEGAL_VERSION = "1.0";
/** Minimum notice of a CGU change (CGU §22.1), in days. */
export const CGU_NOTICE_DAYS = 30;

/**
 * False until the launch reset: the texts may still change under their version. Set to true on
 * the opening day with the hashes of scripts/legal-hash.ts; from then on a text change needs a new
 * version (or `--form-only` for a correction of form, CGU §22.2).
 */
export const LEGAL_TEXTS_FROZEN = false;

export const LEGAL_VERSIONS: Record<LegalSlug, LegalVersion> = {
  // "2026-10": the version sign-up recorded before the texts were versioned (same text).
  cgu: { version: "1.0", effective: "2026-10-28", replaces: ["2026-10"] },
  "referencement-et-classement": { version: "1.0", effective: "2026-10-28" },
  cgv: { version: "0.2", effective: "2026-10-29" },
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

/** Pages whose Arabic text exists (all of them since the CGV, audit D-15); the others would show the French text on the Arabic site. */
export const ARABIC_LEGAL_PAGES: ReadonlySet<LegalSlug> = new Set(Object.keys(LEGAL_VERSIONS) as LegalSlug[]);

/** Pages still provisional (D11): the CGV until the sales gate (phase 7). */
export const PROVISIONAL_LEGAL_PAGES: ReadonlySet<LegalSlug> = new Set<LegalSlug>(["cgv"]);

/** True when a recorded CGU acceptance covers the current CGU (no change notice due). */
export function cguAccepted(stored: string | undefined): boolean {
  const current = LEGAL_VERSIONS.cgu;
  return stored === current.version || (stored !== undefined && (current.replaces ?? []).includes(stored));
}
