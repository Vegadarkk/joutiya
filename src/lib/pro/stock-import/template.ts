import { csvLine } from "./csv";

// Template of the stock file (design concession/concession.md §4), offered for download in the
// Pro area: the French column names the import reads and one example car. Values are the French
// labels a dealer types in a spreadsheet; option ids work too. Client-safe.

export const STOCK_TEMPLATE_COLUMNS = [
  "reference",
  "categorie",
  "titre",
  "description",
  "prix",
  "negociable",
  "ville",
  "quartier",
  "marque",
  "modele",
  "annee",
  "kilometrage",
  "carburant",
  "boite",
  "puissance fiscale",
  "origine",
  "carrosserie",
  "portes",
  "couleur",
  "premiere main",
  "carnet",
  "non accidente",
  "papiers",
  "garantie",
  "duree garantie",
  "reprise",
  "financement",
  "equipements",
] as const;

const EXAMPLE: Record<(typeof STOCK_TEMPLATE_COLUMNS)[number], string> = {
  reference: "DUS-041",
  categorie: "Voitures",
  titre: "Dacia Duster 1.5 dCi Prestige",
  description: "Première main, carnet complet chez Dacia, deux clés. Visible au showroom du lundi au samedi, essai sur rendez-vous.",
  prix: "185000",
  negociable: "non",
  ville: "Casablanca",
  quartier: "Aïn Sebaâ",
  marque: "Dacia",
  modele: "Duster",
  annee: "2022",
  kilometrage: "41000",
  carburant: "Diesel",
  boite: "Manuelle",
  "puissance fiscale": "6",
  origine: "WW au Maroc",
  carrosserie: "SUV / 4x4",
  portes: "5",
  couleur: "Gris",
  "premiere main": "oui",
  carnet: "Complet",
  "non accidente": "oui",
  papiers: "Carte grise au nom du vendeur | Visite technique valide | Libre de gage (mainlevée faite)",
  garantie: "Garantie du vendeur",
  "duree garantie": "6",
  reprise: "oui",
  financement: "oui",
  equipements: "Climatisation | GPS | Caméra de recul | CarPlay / Android Auto",
};

/** The template as CSV text (semicolons, as spreadsheets in French write them), with a byte order mark for Excel. */
export function stockTemplateCsv(): string {
  return `﻿${csvLine(STOCK_TEMPLATE_COLUMNS)}\r\n${csvLine(STOCK_TEMPLATE_COLUMNS.map((column) => EXAMPLE[column]))}\r\n`;
}
