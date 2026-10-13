// Legal pages (§7). The first nine form the footer column "Informations légales", in
// Leboncoin's order; the last three are linked under it (LCEN, DSA art. 11-12, prohibited items).

export const LEGAL_PAGES = [
  { slug: "cgu", key: "cgu", column: "legal" },
  { slug: "referencement-et-classement", key: "referencement", column: "legal" },
  { slug: "cgv", key: "cgv", column: "legal" },
  { slug: "confidentialite", key: "confidentialite", column: "legal" },
  { slug: "cookies", key: "cookies", column: "legal" },
  { slug: "droits-et-obligations", key: "droits", column: "legal" },
  { slug: "avis-utilisateurs", key: "avis", column: "legal" },
  { slug: "confiance-et-securite", key: "confiance", column: "legal" },
  { slug: "paiement-en-plusieurs-fois", key: "paiement", column: "legal" },
  { slug: "mentions-legales", key: "mentions", column: "trust" },
  { slug: "contact-autorites", key: "autorites", column: "trust" },
  { slug: "objets-interdits", key: "interdits", column: "trust" },
] as const;

export type LegalPage = (typeof LEGAL_PAGES)[number];
export type LegalSlug = LegalPage["slug"];
export type LegalKey = LegalPage["key"];

export function legalPage(slug: string): LegalPage | undefined {
  return LEGAL_PAGES.find((page) => page.slug === slug);
}
