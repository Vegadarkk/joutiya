// French labels of the Pro back office (staff only, French): legal forms, identifiers, states.

export const LEGAL_FORM_LABEL: Record<string, string> = {
  societe: "Société",
  auto_entrepreneur: "Auto-entrepreneur",
  commercant: "Commerçant personne physique",
};

export const IDENTIFIER_LABEL: Record<string, string> = {
  ice: "ICE",
  rc: "Registre du commerce (RC)",
  if: "Identifiant fiscal (IF)",
  aeNumber: "N° d'auto-entrepreneur",
  tp: "Taxe professionnelle (TP)",
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
