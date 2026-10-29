import type { GuideSourceId } from "./sources";

// Admin procedures guide (design guide-demarches G1): rubrics by visitor profile, their procedures
// and the official sources each one links to, shared by the three locales. The texts live in fr.ts,
// ar.ts and rif.ts (the compiler and tests/unit/guide-corpus.test.ts check that none is missing).
// Texts may hold `{brand}` (SITE_NAME). They never quote a fee, a delay or a URL: the official page
// states them and may change them at any time. Client-safe.

export const GUIDE_RUBRICS = ["etudiant", "auto-entrepreneur", "vehicule", "immobilier", "mre", "pro-cooperative", "identite"] as const;
export type GuideRubric = (typeof GUIDE_RUBRICS)[number];

export interface GuideProcedureMeta {
  rubric: GuideRubric;
  sources: readonly GuideSourceId[];
}

export const GUIDE_PROCEDURES = {
  // Students
  "bourse-etudes": { rubric: "etudiant", sources: ["mabourse", "onousc-bourses", "onousc-bourses-maroc"] },
  "bourse-etranger": { rubric: "etudiant", sources: ["onousc-bourses-etranger"] },
  "logement-universitaire": { rubric: "etudiant", sources: ["onousc-logement"] },
  "amo-etudiant": { rubric: "etudiant", sources: ["onousc-amo"] },
  "massar": { rubric: "etudiant", sources: ["massar"] },
  // Auto-entrepreneurs
  "ae-inscription": { rubric: "auto-entrepreneur", sources: ["ae-portail"] },
  "ae-impots": { rubric: "auto-entrepreneur", sources: ["dgi-teleservices"] },
  "ae-protection-sociale": { rubric: "auto-entrepreneur", sources: ["cnss"] },
  "ae-services": { rubric: "auto-entrepreneur", sources: ["idarati-entreprises", "maroc-entreprises"] },
  // Vehicles
  "vehicule-mutation": { rubric: "vehicule", sources: ["narsa-mutation", "dgi-teleservices"] },
  "vehicule-vignette": { rubric: "vehicule", sources: ["dgi-teleservices"] },
  "vehicule-permis": { rubric: "vehicule", sources: ["narsa-permis"] },
  "vehicule-mre": { rubric: "vehicule", sources: ["consulat-voiture"] },
  // Property
  "immo-verifier": { rubric: "immobilier", sources: ["ancfcc", "ancfcc-tarifs"] },
  "immo-vente": { rubric: "immobilier", sources: ["dgi-teleservices", "ancfcc"] },
  "immo-taxes-locales": { rubric: "immobilier", sources: ["tgr-taxes-locales"] },
  "immo-location": { rubric: "immobilier", sources: ["idarati-logement"] },
  "immo-location-touristique": { rubric: "immobilier", sources: ["tourisme-hebergement"] },
  // Diaspora
  "mre-services": { rubric: "mre", sources: ["mre-accueil", "mre-consulaire", "mre-justice"] },
  "mre-immatriculation": { rubric: "mre", sources: ["consulat-immatriculation", "consulat-trouver"] },
  "mre-retour": { rubric: "mre", sources: ["consulat-retour"] },
  "mre-procuration": { rubric: "mre", sources: ["consulat-procuration"] },
  // Companies and cooperatives
  "pro-societe": { rubric: "pro-cooperative", sources: ["ompic-creation", "ompic-rcc"] },
  "pro-ice": { rubric: "pro-cooperative", sources: ["ompic-ice"] },
  "pro-cooperative": { rubric: "pro-cooperative", sources: ["odco-creer", "odco-cadre", "odco-delegations"] },
  "pro-obligations": { rubric: "pro-cooperative", sources: ["dgi-teleservices", "cnss"] },
  // Identity and civil status
  "id-cnie": { rubric: "identite", sources: ["cnie", "consulat-cnie"] },
  "id-passeport": { rubric: "identite", sources: ["passeport"] },
  "id-naissance": { rubric: "identite", sources: ["idarati-papiers", "consulat-naissance", "consulat-copie-integrale"] },
  "id-livret": { rubric: "identite", sources: ["consulat-livret"] },
  "id-casier": { rubric: "identite", sources: ["casier", "consulat-casier"] },
  "id-nationalite": { rubric: "identite", sources: ["nationalite"] },
} as const satisfies Record<string, GuideProcedureMeta>;
export type GuideProcedureId = keyof typeof GUIDE_PROCEDURES;
export const GUIDE_PROCEDURE_IDS = Object.keys(GUIDE_PROCEDURES) as GuideProcedureId[];

/** Portals for every profile (the guide's home page). */
export const GUIDE_GENERAL_SOURCES: readonly GuideSourceId[] = ["maroc-grand-public", "maroc-entreprises", "chikaya"];

/** Site categories a rubric serves: their listing pages link to it. */
export const GUIDE_RUBRIC_CATEGORIES: Readonly<Partial<Record<GuideRubric, readonly string[]>>> = {
  vehicule: ["vehicules"],
  immobilier: ["immobilier"],
};

export interface GuideProcedureText {
  title: string;
  /** What it is, who does it, in what order: one or two short paragraphs. */
  body: readonly string[];
  /** Optional: what to have ready (generic items only, the official page holds the full list). */
  prepare?: readonly string[];
}

export interface GuideRubricText {
  title: string;
  /** One sentence: cards and the page's description. */
  summary: string;
  intro: string;
}

export interface GuideLocaleContent {
  rubrics: Readonly<Record<GuideRubric, GuideRubricText>>;
  procedures: Readonly<Record<GuideProcedureId, GuideProcedureText>>;
  /** Label of each official link, in the visitor's language. */
  sources: Readonly<Record<GuideSourceId, string>>;
}

export function isGuideRubric(value: string): value is GuideRubric {
  return (GUIDE_RUBRICS as readonly string[]).includes(value);
}

export function rubricProcedures(rubric: GuideRubric): GuideProcedureId[] {
  return GUIDE_PROCEDURE_IDS.filter((id) => GUIDE_PROCEDURES[id].rubric === rubric);
}

/** The rubric serving a site category, if any. */
export function rubricForCategory(categoryId: string): GuideRubric | undefined {
  return GUIDE_RUBRICS.find((rubric) => GUIDE_RUBRIC_CATEGORIES[rubric]?.includes(categoryId));
}
