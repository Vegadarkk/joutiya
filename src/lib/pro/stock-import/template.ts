import { csvLine } from "./csv";

// Templates of the stock file (design concession/concession.md §4), offered for download in the
// Pro area: the French column names the import reads and one example car, for sale or for rent.
// Values are the French labels a dealer types in a spreadsheet; option ids work too. Client-safe.

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

/** Fleet of a car rental agency (rental pack §3): one example car, its terms and its blocked periods. */
export const RENTAL_TEMPLATE_COLUMNS = [
  "reference",
  "categorie",
  "titre",
  "description",
  "prix",
  "ville",
  "quartier",
  "gamme",
  "marque",
  "modele",
  "annee",
  "boite",
  "carburant",
  "places",
  "duree minimum",
  "kilometrage",
  "assurance",
  "franchise",
  "caution",
  "age minimum",
  "permis",
  "remise",
  "tarif semaine",
  "tarif mois",
  "unites",
  "indisponible",
] as const;

const RENTAL_EXAMPLE: Record<(typeof RENTAL_TEMPLATE_COLUMNS)[number], string> = {
  reference: "LOG-01",
  categorie: "Location de voitures",
  titre: "Dacia Logan diesel ou similaire",
  description: "Berline récente et climatisée, idéale pour la ville et la route. Remise en agence à Guéliz ou à l'aéroport Marrakech Menara.",
  prix: "300",
  ville: "Marrakech",
  quartier: "Guéliz",
  gamme: "Berline",
  marque: "Dacia",
  modele: "Logan",
  annee: "2024",
  boite: "Manuelle",
  carburant: "Diesel",
  places: "5",
  "duree minimum": "2",
  kilometrage: "Illimité",
  assurance: "Tous risques avec franchise",
  franchise: "5000",
  caution: "5000",
  "age minimum": "21",
  permis: "2",
  remise: "En agence | À l'aéroport",
  "tarif semaine": "260",
  "tarif mois": "220",
  unites: "3",
  indisponible: "2026-12-20/2027-01-03",
};

/**
 * A shop's goods (catalogue §2): one line per combination of a shirt in sizes and colours, grouped
 * by its reference; the next lines leave the listing's cells empty, one gives its own price.
 */
export const SHOP_TEMPLATE_COLUMNS = ["reference", "categorie", "titre", "description", "prix", "etat", "ville", "pour qui", "type de vetement", "variante_1", "variante_2", "stock"] as const;

const SHOP_EXAMPLES: readonly Partial<Record<(typeof SHOP_TEMPLATE_COLUMNS)[number], string>>[] = [
  {
    reference: "CHM-LIN",
    categorie: "Vêtements",
    titre: "Chemise en lin brodée main",
    description: "Chemise en lin lavé, broderie faite main dans notre atelier de Fès, coupe droite.",
    prix: "250",
    etat: "Neuf avec étiquette",
    ville: "Fès",
    "pour qui": "Homme",
    "type de vetement": "Haut & t-shirt",
    variante_1: "Taille : M",
    variante_2: "Couleur : Bleu",
    stock: "4",
  },
  { reference: "CHM-LIN", variante_1: "Taille : L", variante_2: "Couleur : Bleu", stock: "2" },
  { reference: "CHM-LIN", prix: "290", variante_1: "Taille : XL", variante_2: "Couleur : Noir", stock: "0" },
];

export type StockTemplateKind = "sale" | "rental" | "shop";

/** A template as CSV text (semicolons, as spreadsheets in French write them), with a byte order mark for Excel. */
export function stockTemplateCsv(kind: StockTemplateKind = "sale"): string {
  const [columns, examples]: [readonly string[], readonly Record<string, string>[]] =
    kind === "rental" ? [RENTAL_TEMPLATE_COLUMNS, [RENTAL_EXAMPLE]] : kind === "shop" ? [SHOP_TEMPLATE_COLUMNS, SHOP_EXAMPLES] : [STOCK_TEMPLATE_COLUMNS, [EXAMPLE]];
  return `﻿${[columns, ...examples.map((example) => columns.map((column) => example[column] ?? ""))].map((cells) => `${csvLine(cells)}\r\n`).join("")}`;
}
