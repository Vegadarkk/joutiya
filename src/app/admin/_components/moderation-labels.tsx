import "server-only";
import { criterionById, subcategoryById } from "@/config/categories";
import type { ProhibitedGroupId } from "@/config/prohibited";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import type { SensitiveCategoryId } from "@/config/sensitive";
import { loadMessages } from "@/i18n/messages";
import type { ListingAttributes } from "@/lib/contracts/listings";

// French labels of the catalogue for the back office (the admin host has no next-intl provider):
// categories, criteria and their options, places, conditions, listing statuses, and the evidence
// lines of the pre-moderation screen.

type Tree = { [key: string]: string | Tree };

function at(tree: Tree, ...path: string[]): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const key of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return typeof node === "string" ? node : undefined;
}

const number = new Intl.NumberFormat("fr-FR");

export interface CatalogLabels {
  category(categoryId: string | null, subcategoryId: string | null): string;
  place(citySlug: string | null, regionCode?: string | null): string;
  criterion(id: string): string;
  value(id: string, value: ListingAttributes[string]): string;
  condition(value: string): string;
  status(status: string): string;
  /** An evidence line of the screen (src/lib/moderation/screen.ts) in French. */
  evidence(line: string): string;
}

export async function catalogLabels(): Promise<CatalogLabels> {
  const messages = (await loadMessages("fr")) as unknown as Tree;
  const option = (id: string, value: string) => at(messages, "Criteria", id, "options", value) ?? value;
  const labels: CatalogLabels = {
    category(categoryId, subcategoryId) {
      if (!categoryId) return "Sans catégorie";
      const name = at(messages, "Categories", categoryId, "name") ?? categoryId;
      const sub = subcategoryId ? (at(messages, "Categories", categoryId, "sub", subcategoryId) ?? subcategoryId) : null;
      return sub ? `${name} › ${sub}` : name;
    },
    place(citySlug, regionCode) {
      const city = citySlug ? cityBySlug(citySlug) : undefined;
      const region = regionByCode(regionCode ?? city?.regionCode ?? "");
      if (!city) return "Lieu non renseigné";
      return region ? `${cityName(city, "fr")}, ${regionName(region, "fr")}` : cityName(city, "fr");
    },
    criterion: (id) => at(messages, "Criteria", id, "label") ?? id,
    value(id, value) {
      if (Array.isArray(value)) return value.map((item) => option(id, item)).join(", ");
      if (typeof value === "boolean") return value ? "Oui" : "Non";
      if (typeof value === "number") {
        const unit = criterionById(id)?.unit;
        const label = unit ? at(messages, "Listing", "units", unit) : undefined;
        return label ? `${number.format(value)} ${label}` : number.format(value);
      }
      return option(id, value);
    },
    condition: (value) => at(messages, "Criteria", "condition", "options", value) ?? value,
    status: (status) => at(messages, "Listing", "status", status) ?? status,
    evidence: (line) => evidenceLabel(line, labels),
  };
  return labels;
}

const PROHIBITED_GROUP_LABEL: Record<ProhibitedGroupId, string> = {
  weapons: "armes",
  drugs: "drogues",
  counterfeit: "contrefaçons",
  stolen: "objets volés",
  identity_documents: "papiers d'identité",
  human: "services sexuels, traite ou organes",
  protected_species: "espèces protégées",
  medicines: "médicaments",
  hacking_piracy: "piratage",
  gambling: "jeux d'argent",
  inalienable_land: "terres collectives ou habous",
  job_scam: "paiement demandé à un candidat",
  job_discrimination: "offre d'emploi discriminatoire",
  job_minors: "emploi d'un mineur",
};

const SENSITIVE_LABEL: Record<SensitiveCategoryId, string> = {
  id_number: "numéro d'identité",
  bank_account: "coordonnées bancaires",
  card_number: "numéro de carte bancaire",
  health: "santé",
  religion: "religion",
  ethnicity: "origine ethnique",
  politics: "opinions politiques",
  sexual_orientation: "orientation sexuelle",
};

const SENSITIVE_PATTERN_LABEL: Record<string, string> = {
  "iban pattern": "IBAN",
  "rib pattern": "RIB",
  "card number pattern": SENSITIVE_LABEL.card_number,
  "identity number pattern": SENSITIVE_LABEL.id_number,
};

const DECLARATION_LABEL: Record<string, string> = { self: "le vendeur est la personne concernée", explicit_consent: "consentement explicite de la personne concernée" };

const plural = (count: number, one: string, other: string) => `${count} ${count > 1 ? other : one}`;
const decimal = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Evidence lines are built in English by the screen (stable, logged and tested as is); the review
 * shows them in French. Unknown lines (a new rule not mapped here yet) are shown unchanged.
 */
export function evidenceLabel(line: string, labels: Pick<CatalogLabels, "category" | "criterion">): string {
  const field = (path: string): string => {
    if (path === "title") return "le titre";
    if (path === "description") return "la description";
    if (path === "location.district") return "le quartier";
    if (path.startsWith("attributes.")) return `le critère « ${labels.criterion(path.slice("attributes.".length))} »`;
    return path;
  };
  const amount = (value: string) => (/^\d+$/.test(value) ? number.format(Number(value)) : value);
  const sensitive = (hit: string): string | undefined => {
    if (SENSITIVE_PATTERN_LABEL[hit]) return SENSITIVE_PATTERN_LABEL[hit];
    const vocabulary = /^(\w+) vocabulary( near a person marker| near a restriction marker)?$/.exec(hit);
    const label = vocabulary ? SENSITIVE_LABEL[vocabulary[1] as SensitiveCategoryId] : undefined;
    if (!vocabulary || !label) return undefined;
    if (vocabulary[2] === " near a person marker") return `${label}, près d'une mention de personne`;
    if (vocabulary[2] === " near a restriction marker") return `${label}, près d'une restriction`;
    return label;
  };

  let match: RegExpExecArray | null;
  if ((match = /^phone pattern in (\S+)$/.exec(line))) return `Numéro de téléphone dans ${field(match[1]!)}`;
  if ((match = /^email in (\S+)$/.exec(line))) return `Adresse e-mail dans ${field(match[1]!)}`;
  if ((match = /^url in (\S+)$/.exec(line))) return `Lien dans ${field(match[1]!)}`;
  if ((match = /^prohibited (hard|soft):(\w+) in (\S+)$/.exec(line))) {
    const group = PROHIBITED_GROUP_LABEL[match[2] as ProhibitedGroupId] ?? match[2];
    return `${match[1] === "hard" ? "Mot-clé interdit" : "Vocabulaire à risque"} (${group}) dans ${field(match[3]!)}`;
  }
  if ((match = /^sensitive (.+) in (\S+)$/.exec(line))) {
    const label = sensitive(match[1]!);
    if (label) return `Donnée sensible (${label}) dans ${field(match[2]!)}`;
  }
  if ((match = /^(\d+) distinct phone numbers in text$/.exec(line))) return `${match[1]} numéros de téléphone différents dans les textes`;
  if ((match = /^face on photo (\d+)$/.exec(line))) return `Visage sur la photo ${match[1]}`;
  if ((match = /^nsfw (\d+(?:\.\d+)?) on photo (\d+)( \(above reject threshold\))?$/.exec(line))) {
    return `Nudité probable (score ${decimal.format(Number(match[1]))}) sur la photo ${match[2]}${match[3] ? ", au-delà du seuil de refus" : ""}`;
  }
  if ((match = /^price (\d+) outside (\S+)-(\S+) \((.+)\)$/.exec(line))) {
    const subcategory = match[4]!;
    const where = labels.category(subcategoryById(subcategory)?.categoryId ?? null, subcategory);
    return `Prix de ${amount(match[1]!)} DH hors de la fourchette habituelle ${amount(match[2]!)}–${amount(match[3]!)} DH (${where})`;
  }
  if ((match = /^same (text|photo) as (\d+) listing\(s\)$/.exec(line))) {
    const count = Number(match[2]);
    return `${match[1] === "text" ? "Même texte" : "Même photo"} que ${plural(count, "autre annonce", "autres annonces")} du vendeur`;
  }
  if ((match = /^account age (\d+) day\(s\)$/.exec(line))) {
    const days = Number(match[1]);
    return days === 0 ? "Compte créé aujourd'hui" : `Compte créé il y a ${plural(days, "jour", "jours")}`;
  }
  if ((match = /^(\d+) listings in 24h$/.exec(line))) return `${plural(Number(match[1]), "annonce", "annonces")} en 24 h`;
  if ((match = /^(\d+) previous rejection\(s\)$/.exec(line))) return `${plural(Number(match[1]), "refus antérieur", "refus antérieurs")}`;
  if ((match = /^ONSSA number (\S+) not yet checked for this shop$/.exec(line))) {
    return `N° ONSSA ${match[1]} encore jamais vérifié pour cette boutique : cherchez-le dans les listes de l'ONSSA (onssa.gov.ma, établissements agréés ou autorisés). Absent des listes, demandez le justificatif au Pro avant de refuser, les listes ont du retard.`;
  }
  if ((match = /^declaration (\w+)$/.exec(line))) return `Déclaration du vendeur : ${DECLARATION_LABEL[match[1]!] ?? match[1]}`;
  return line;
}

/** "il y a 3 heures" from an ISO date. */
export function waitingFor(isoDate: string, now = new Date()): string {
  const minutes = Math.round((new Date(isoDate).getTime() - now.getTime()) / 60_000);
  const format = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function formatPrice(price: number | null, isDonation: boolean): string {
  if (isDonation) return "Don";
  if (price === null) return "Prix à discuter";
  return `${number.format(price)} DH`;
}
