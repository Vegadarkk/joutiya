// French labels of the Pro back office (staff only, French): legal forms, identifiers, states.

export const LEGAL_FORM_LABEL: Record<string, string> = {
  societe: "Société",
  auto_entrepreneur: "Auto-entrepreneur",
  commercant: "Commerçant personne physique",
  cooperative: "Coopérative",
};

export const IDENTIFIER_LABEL: Record<string, string> = {
  ice: "ICE",
  rc: "Registre du commerce (RC)",
  if: "Identifiant fiscal (IF)",
  aeNumber: "N° d'auto-entrepreneur",
  tp: "Taxe professionnelle (TP)",
  coopNumber: "N° d'immatriculation au registre des coopératives",
};

export const LIFECYCLE_LABEL: Record<string, string> = {
  pending_verification: "En attente de vérification",
  verified: "Vérifiée",
  active: "Active",
  grace: "Paiement en échec (grâce)",
  downgraded: "Sans offre",
  rejected: "Refusée",
  suspended: "Suspendue",
};

export const PHONE_OUTCOME_LABEL: Record<string, string> = {
  verified: "Joint, numéro confirmé",
  unreachable: "Injoignable",
  mismatch: "Le numéro n'est pas celui du demandeur",
};

/** ICE in groups of three digits (15 digits), for reading it aloud or against a registry. */
export function formatIce(ice: string): string {
  return /^\d{15}$/.test(ice) ? ice.replace(/(\d{3})(?=\d)/g, "$1 ") : ice;
}

/** Car rental licence check (decision 5): its status and why the AI check left it to a moderator. */
export const RENTAL_CHECK_STATUS_LABEL: Record<string, string> = {
  pending: "Lecture IA en cours",
  review: "À contrôler",
  verified: "Contrôlé",
  rejected: "Refusé",
};

export const RENTAL_CHECK_ISSUE_LABEL: Record<string, string> = {
  not_agrement: "Ce n'est pas une décision d'agrément",
  unreadable: "Document illisible ou incomplet",
  reference: "Numéro différent de celui déclaré",
  company: "Bénéficiaire différent de la boutique (ICE ou nom)",
  date: "Date absente du calendrier ou future",
  tampering: "Signes de retouche relevés",
  low_confidence: "Lecture peu sûre",
  ai_unavailable: "Lecture IA indisponible",
};
