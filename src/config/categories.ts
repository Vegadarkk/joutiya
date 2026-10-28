import { z } from "@/lib/zod";

// Category tree and declarative criteria (phase 3, design §2; product research §1). Client-safe:
// the wizard renders the fields from this file and the API validates `attributes` with
// `criteriaSchema(subcategoryId)` at publish. Ids are kebab-case ASCII and never displayed.
//
// Labels live in the messages (fr/ar), never here:
//   Categories.<categoryId>.name           name of a category
//   Categories.<categoryId>.sub.<subId>    name of a subcategory
//   Criteria.<fieldId>.label               label of a criterion (shared across subcategories)
//   Criteria.<fieldId>.options.<optionId>  label of a select/multiselect option
//   Criteria.condition.*                   the core `condition` field (listing schema, not an attribute)
// tests/unit/categories.test.ts keeps ids and labels in sync in both directions.

/** Common `condition` field (5 levels), on the listing itself where goods are sold (§5). */
export const CONDITIONS = ["new_tagged", "like_new", "very_good", "good", "for_parts"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CRITERION_TYPES = ["select", "multiselect", "number", "boolean", "text"] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];

export const CRITERION_UNITS = ["km", "cv", "m2", "an", "go", "nuit", "mois"] as const;
export type CriterionUnit = (typeof CRITERION_UNITS)[number];

/** Max length of a free-text criterion (model, brand, breed). */
export const CRITERION_TEXT_MAX = 80;

export interface Criterion {
  id: string;
  type: CriterionType;
  required?: boolean;
  /** select / multiselect: option ids. */
  options?: readonly string[];
  /** number: inclusive bounds (integers). */
  min?: number;
  max?: number;
  unit?: CriterionUnit;
  step?: number;
  /**
   * `dossier`: history, papers, warranty and equipment of a vehicle (Concession pack, 2026-10-28):
   * a folded block of the wizard, its own section on the listing page. Absent = main criteria.
   */
  group?: CriterionGroup;
  /** A dossier criterion offered as a search filter (main criteria always are, text excepted). */
  filter?: boolean;
  /**
   * Pro sellers only (dealer's stock reference, real-estate mandate, ONSSA number): hidden from
   * individuals in the form, refused at publish (`criterion_pro_only`) when an individual sets it;
   * `required` then binds Pros only.
   */
  proOnly?: boolean;
  /** Shown and accepted only while criterion `id` holds one of `values` (a warranty's duration). */
  showIf?: { id: string; values: readonly string[] };
}

export const CRITERION_GROUPS = ["dossier"] as const;
export type CriterionGroup = (typeof CRITERION_GROUPS)[number];

/**
 * Main criteria of a subcategory stay short (a property sale needs 12: rooms and title status on
 * top of Leboncoin's ten); the Pro-only ones and the folded dossier have their own caps.
 */
export const MAIN_CRITERIA_MAX = 12;
export const PRO_CRITERIA_MAX = 8;
export const DOSSIER_CRITERIA_MAX = 12;

/** Price per unit shown next to the amount; the amount itself stays an integer MAD (D4). */
export const PRICE_UNITS = ["night", "month", "day"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export interface Subcategory {
  id: string;
  categoryId: string;
  criteria: readonly Criterion[];
  /** Goods: `condition` shown; "required" when buyers expect it (fashion, electronics). */
  condition?: "required" | "optional";
  /** `price` may be null ("à discuter"): services, pro equipment, rentals. */
  priceOptional?: boolean;
  priceUnit?: PriceUnit;
  /** `isDonation` allowed. */
  donationAllowed?: boolean;
  /** Reserved to Pro accounts (waitlist until phase 7). */
  proOnly?: boolean;
  /**
   * Restricted goods sold to adults only (owner decisions of 2026-10-21 and 2026-10-26): every
   * listing is reviewed by a moderator before publication, the seller attests it at publish,
   * contact goes through the messaging only, and a buyer confirms being 18 or older before the
   * first message. Listings stay public, with an 18+ notice.
   */
  adultsOnly?: boolean;
}

export interface Category {
  id: string;
  subcategories: readonly Subcategory[];
  /**
   * Criteria offered as search filters on the whole category, before a subcategory is chosen
   * (surface or bedrooms across every real-estate offer). A listing of a subcategory without the
   * field never matches a filter on it.
   */
  sharedFilters?: readonly CriterionId[];
  /** Number criteria shown on result cards under the title, in order ("95 m² · 5 pièces"). */
  cardFacts?: readonly CriterionId[];
}

/** Car brands common in Morocco, plus `autre`; the model stays free text. */
export const CAR_BRANDS = [
  "dacia", "renault", "peugeot", "citroen", "ds", "volkswagen", "audi", "bmw",
  "mercedes-benz", "opel", "fiat", "alfa-romeo", "lancia", "ford", "toyota", "hyundai",
  "kia", "nissan", "honda", "mazda", "mitsubishi", "suzuki", "subaru", "daihatsu",
  "isuzu", "lexus", "infiniti", "skoda", "seat", "cupra", "porsche", "mini",
  "smart", "land-rover", "jaguar", "volvo", "jeep", "chevrolet", "dodge", "chrysler",
  "cadillac", "tesla", "byd", "chery", "geely", "mg", "jac", "dfsk",
  "haval", "great-wall", "changan", "baic", "ssangyong", "maserati", "ferrari", "lamborghini",
  "bentley", "rolls-royce", "aston-martin", "lada", "tata", "mahindra", "autre",
] as const;
export type CarBrand = (typeof CAR_BRANDS)[number];

const YEAR_MAX = new Date().getUTCFullYear() + 1;

type FieldDef = Omit<Criterion, "required" | "group" | "filter">;

/** One definition per field id, shared by every subcategory that lists it (same label, same options). */
const FIELDS = {
  "car-brand": { id: "car-brand", type: "select", options: CAR_BRANDS },
  "model": { id: "model", type: "text" },
  "year": { id: "year", type: "number", min: 1950, max: YEAR_MAX, unit: "an" },
  "mileage": { id: "mileage", type: "number", min: 0, max: 1000000, unit: "km" },
  "fuel": { id: "fuel", type: "select", options: ["diesel", "essence", "hybride", "electrique", "gpl"] },
  "gearbox": { id: "gearbox", type: "select", options: ["manuelle", "automatique"] },
  "fiscal-power": { id: "fiscal-power", type: "number", min: 3, max: 60, unit: "cv" },
  "origin": { id: "origin", type: "select", options: ["ww-maroc", "dedouanee", "importee-neuve", "pas-dedouanee"] },
  "first-hand": { id: "first-hand", type: "boolean" },
  "doors": { id: "doors", type: "select", options: ["2", "3", "4", "5"] },
  // Vehicle dossier (Concession pack, design concession/concession.md §2).
  "body-type": { id: "body-type", type: "select", options: ["citadine", "compacte", "berline", "break", "suv-4x4", "coupe", "cabriolet", "monospace", "pick-up"] },
  "service-history": { id: "service-history", type: "select", options: ["complet", "partiel", "aucun"] },
  "no-accident": { id: "no-accident", type: "boolean" },
  "vehicle-papers": { id: "vehicle-papers", type: "multiselect", options: ["carte-grise", "visite-technique", "libre-de-gage", "factures-entretien", "double-cles"] },
  "vehicle-warranty": { id: "vehicle-warranty", type: "select", options: ["constructeur", "vendeur", "aucune"] },
  "warranty-months": { id: "warranty-months", type: "number", min: 1, max: 120, unit: "mois", showIf: { id: "vehicle-warranty", values: ["constructeur", "vendeur"] } },
  "trade-in": { id: "trade-in", type: "boolean" },
  "financing": { id: "financing", type: "boolean" },
  "car-equipment": { id: "car-equipment", type: "multiselect", options: ["climatisation", "gps", "camera-recul", "radar-recul", "carplay-android-auto", "regulateur", "toit-ouvrant", "sieges-cuir", "jantes-alu", "transmission-4x4"] },
  "stock-ref": { id: "stock-ref", type: "text", proOnly: true },
  "moto-brand": { id: "moto-brand", type: "select", options: ["yamaha", "honda", "suzuki", "kawasaki", "bmw", "ktm", "ducati", "piaggio", "vespa", "sym", "kymco", "peugeot", "aprilia", "triumph", "harley-davidson", "docker", "becane", "haojue", "lifan", "autre"] },
  "engine-size": { id: "engine-size", type: "select", options: ["moins-50", "50-125", "126-250", "251-500", "501-750", "plus-750"] },
  "bike-type": { id: "bike-type", type: "select", options: ["vtt", "route", "ville", "electrique", "enfant", "bmx", "pliant", "autre"] },
  "bike-size": { id: "bike-size", type: "select", options: ["enfant", "xs", "s", "m", "l", "xl"] },
  "brand": { id: "brand", type: "text" },
  "utility-type": { id: "utility-type", type: "select", options: ["fourgon", "camionnette", "camion", "pickup", "bus-minibus", "remorque", "autre"] },
  "boat-type": { id: "boat-type", type: "select", options: ["bateau-moteur", "voilier", "pneumatique", "jet-ski", "barque", "autre"] },
  "engine-power": { id: "engine-power", type: "number", min: 1, max: 2000, unit: "cv" },
  "part-type": { id: "part-type", type: "select", options: ["pneus-jantes", "moteur-mecanique", "carrosserie", "electronique-auto", "interieur", "audio-gps", "accessoires-moto", "outillage", "autre"] },
  "vehicle-kind": { id: "vehicle-kind", type: "select", options: ["voiture", "moto", "velo", "utilitaire", "autre"] },
  "property-type": { id: "property-type", type: "select", options: ["appartement", "maison", "villa-riad", "terrain-ferme", "bureau", "local-commercial", "studio", "autre"] },
  "surface": { id: "surface", type: "number", min: 1, max: 1000000, unit: "m2" },
  "bedrooms": { id: "bedrooms", type: "number", min: 0, max: 30 },
  "living-rooms": { id: "living-rooms", type: "number", min: 0, max: 10 },
  "bathrooms": { id: "bathrooms", type: "number", min: 0, max: 10 },
  "floor": { id: "floor", type: "number", min: -2, max: 80 },
  "standing": { id: "standing", type: "select", options: ["economique", "moyen", "haut"] },
  "property-age": { id: "property-age", type: "select", options: ["neuf", "1-5-ans", "6-10-ans", "11-20-ans", "plus-20-ans"] },
  "furnished": { id: "furnished", type: "boolean" },
  "amenities": { id: "amenities", type: "multiselect", options: ["parking", "ascenseur", "climatisation", "securite", "cuisine-equipee", "terrasse", "jardin", "piscine", "chauffage"] },
  "deposit": { id: "deposit", type: "number", min: 0, max: 10000000 },
  "availability": { id: "availability", type: "select", options: ["immediate", "a-convenir"] },
  "room-type": { id: "room-type", type: "select", options: ["chambre-privee", "chambre-partagee"] },
  "flatmates": { id: "flatmates", type: "number", min: 1, max: 10 },
  "guests": { id: "guests", type: "number", min: 1, max: 5000 },
  // Real estate (Agence pack design, phase-7/agence-immobiliere.md). Moroccan listings count rooms
  // ("pièces") apart from bedrooms; the title status matters to buyers (melkia is not a land title).
  "rooms": { id: "rooms", type: "number", min: 1, max: 50 },
  "property-title": { id: "property-title", type: "select", options: ["titre-foncier", "en-cours-immatriculation", "melkia-adoul", "autre"] },
  /** Tourist accommodation authorisation (law 80-14): declared by the host, never checked by the site. */
  "tourism-authorization": { id: "tourism-authorization", type: "text" },
  /** Pro fields: the mandate, the agency's own reference and its fees next to the price (law 31-08 art. 3). */
  "mandate": { id: "mandate", type: "select", options: ["exclusif", "simple", "vente-directe"] },
  "agency-reference": { id: "agency-reference", type: "text" },
  "agency-fees": { id: "agency-fees", type: "select", options: ["inclus", "en-sus", "sans-frais"] },
  "agency-fees-amount": { id: "agency-fees-amount", type: "number", min: 0, max: 10000000 },
  /** Off-plan sale (VEFA, law 44-00): the permit and the planned delivery year come with it. */
  "off-plan": { id: "off-plan", type: "boolean" },
  "building-permit": { id: "building-permit", type: "text" },
  "delivery-year": { id: "delivery-year", type: "number", min: 2020, max: 2045, unit: "an" },
  "min-nights": { id: "min-nights", type: "number", min: 1, max: 90, unit: "nuit" },
  "phone-device-type": { id: "phone-device-type", type: "select", options: ["smartphone", "telephone-basique", "montre-connectee", "ecouteurs", "bracelet", "autre"] },
  "phone-brand": { id: "phone-brand", type: "select", options: ["apple", "samsung", "xiaomi", "huawei", "oppo", "realme", "infinix", "tecno", "honor", "nokia", "google", "oneplus", "vivo", "motorola", "autre"] },
  "storage": { id: "storage", type: "select", options: ["16-go", "32-go", "64-go", "128-go", "256-go", "512-go", "1-to", "plus-1-to"] },
  "warranty": { id: "warranty", type: "boolean" },
  "computer-type": { id: "computer-type", type: "select", options: ["portable", "bureau", "tout-en-un", "mini-pc", "autre"] },
  "computer-brand": { id: "computer-brand", type: "select", options: ["apple", "hp", "dell", "lenovo", "asus", "acer", "msi", "microsoft", "samsung", "toshiba", "huawei", "autre"] },
  "ram": { id: "ram", type: "select", options: ["4-go", "8-go", "16-go", "32-go", "plus-32-go"] },
  "tablet-brand": { id: "tablet-brand", type: "select", options: ["apple", "samsung", "huawei", "xiaomi", "lenovo", "microsoft", "amazon", "alcatel", "autre"] },
  "accessory-type": { id: "accessory-type", type: "select", options: ["chargeurs-cables", "coques-protections", "batteries-externes", "cartes-memoire", "claviers-souris", "supports", "autre"] },
  "av-type": { id: "av-type", type: "select", options: ["televiseur", "projecteur", "appareil-photo", "objectif", "camera", "enceinte", "casque", "home-cinema", "autre"] },
  "gaming-type": { id: "gaming-type", type: "select", options: ["console", "jeu", "accessoire-gaming", "autre"] },
  "platform": { id: "platform", type: "select", options: ["playstation-5", "playstation-4", "xbox-series", "xbox-one", "nintendo-switch", "pc", "retro", "autre"] },
  "furniture-type": { id: "furniture-type", type: "select", options: ["salon-marocain", "salon", "table-chaises", "lit-matelas", "armoire-rangement", "bureau", "meuble-tv", "autre"] },
  "material": { id: "material", type: "select", options: ["bois", "metal", "verre", "tissu", "cuir", "rotin", "plastique", "ceramique", "cuivre", "autre"] },
  "color": { id: "color", type: "select", options: ["noir", "blanc", "gris", "beige", "marron", "bleu", "vert", "rouge", "jaune", "orange", "rose", "violet", "dore", "argente", "multicolore", "autre"] },
  "appliance-type": { id: "appliance-type", type: "select", options: ["refrigerateur", "congelateur", "lave-linge", "lave-vaisselle", "four", "cuisiniere", "micro-ondes", "hotte", "climatiseur", "chauffe-eau", "aspirateur", "petit-electromenager", "autre"] },
  "decor-type": { id: "decor-type", type: "select", options: ["tapis", "dinanderie", "poterie-ceramique", "luminaire", "miroir", "tableau", "zellige", "bois-sculpte", "autre"] },
  "handmade": { id: "handmade", type: "boolean" },
  "linen-type": { id: "linen-type", type: "select", options: ["literie", "serviettes", "rideaux", "nappes", "couvertures", "autre"] },
  "tableware-type": { id: "tableware-type", type: "select", options: ["vaisselle", "verres", "couverts", "service-the", "cocotte-ustensiles", "plateaux", "autre"] },
  "diy-type": { id: "diy-type", type: "select", options: ["outillage-electrique", "outillage-main", "plomberie", "electricite", "peinture", "materiaux", "quincaillerie", "autre"] },
  "garden-type": { id: "garden-type", type: "select", options: ["mobilier-jardin", "plantes", "outillage-jardin", "arrosage", "barbecue", "piscine-spa", "abri", "autre"] },
  "audience": { id: "audience", type: "select", options: ["femme", "homme", "enfant", "mixte"] },
  "clothing-type": { id: "clothing-type", type: "select", options: ["haut", "pantalon", "robe", "jupe", "veste-manteau", "costume", "sport", "lingerie-nuit", "maillot", "autre"] },
  "clothing-size": { id: "clothing-size", type: "select", options: ["xs", "s", "m", "l", "xl", "xxl", "xxxl", "34", "36", "38", "40", "42", "44", "46", "48", "unique"] },
  "traditional-type": { id: "traditional-type", type: "select", options: ["caftan", "takchita", "djellaba", "gandoura", "jabador", "abaya", "babouches-accessoires", "autre"] },
  "shoe-type": { id: "shoe-type", type: "select", options: ["baskets", "ville", "bottes", "sandales", "babouches", "sport", "autre"] },
  "shoe-size": { id: "shoe-size", type: "select", options: ["35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "autre"] },
  "fashion-accessory-type": { id: "fashion-accessory-type", type: "select", options: ["sac-a-main", "sac-a-dos", "portefeuille", "ceinture", "foulard", "lunettes", "chapeau", "autre"] },
  "jewelry-type": { id: "jewelry-type", type: "select", options: ["montre", "bague", "collier", "bracelet", "boucles-oreilles", "parure", "autre"] },
  "jewelry-material": { id: "jewelry-material", type: "select", options: ["or", "argent", "acier", "plaque", "fantaisie", "autre"] },
  "baby-type": { id: "baby-type", type: "select", options: ["poussette", "siege-auto", "lit-bebe", "chaise-haute", "porte-bebe", "jouets-eveil", "soins-bain", "autre"] },
  "child-age": { id: "child-age", type: "select", options: ["0-6-mois", "6-12-mois", "1-2-ans", "2-4-ans", "4-8-ans", "8-ans-plus"] },
  "child-clothing-type": { id: "child-clothing-type", type: "select", options: ["haut", "pantalon", "robe", "ensemble", "manteau", "pyjama", "chaussures-enfant", "autre"] },
  "child-audience": { id: "child-audience", type: "select", options: ["fille", "garcon", "mixte"] },
  "child-furniture-type": { id: "child-furniture-type", type: "select", options: ["lit", "bureau", "rangement", "chaise", "parc", "autre"] },
  "sport-type": { id: "sport-type", type: "select", options: ["fitness-musculation", "football", "randonnee-camping", "natation-plage", "sports-raquettes", "sports-combat", "surf-glisse", "peche-chasse", "autre"] },
  "instrument-type": { id: "instrument-type", type: "select", options: ["guitare", "piano-clavier", "percussions", "traditionnels", "vent", "cordes", "dj-sono", "accessoires-musique", "autre"] },
  "book-type": { id: "book-type", type: "select", options: ["roman", "scolaire-universitaire", "religion", "jeunesse", "bd-manga", "pratique", "langues", "autre"] },
  "book-language": { id: "book-language", type: "select", options: ["francais", "arabe", "anglais", "amazigh", "espagnol", "autre"] },
  "toy-type": { id: "toy-type", type: "select", options: ["jeux-societe", "puzzles", "figurines", "poupees", "voitures-miniatures", "jeux-construction", "peluches", "exterieur", "autre"] },
  "collectible-type": { id: "collectible-type", type: "select", options: ["monnaies-billets", "timbres", "objets-anciens", "art", "montres-anciennes", "livres-anciens", "autre"] },
  "pet-accessory-type": { id: "pet-accessory-type", type: "select", options: ["alimentation", "cage-aquarium", "laisse-collier", "couchage", "jouets", "toilettage", "autre"] },
  "animal-type": { id: "animal-type", type: "select", options: ["chien", "chat", "oiseau", "poisson", "rongeur", "reptile", "autre"] },
  "breed": { id: "breed", type: "text" },
  "animal-age": { id: "animal-age", type: "select", options: ["moins-3-mois", "3-12-mois", "1-5-ans", "plus-5-ans"] },
  "animal-sex": { id: "animal-sex", type: "select", options: ["male", "femelle"] },
  "vaccinated": { id: "vaccinated", type: "boolean" },
  "livestock-type": { id: "livestock-type", type: "select", options: ["mouton", "chevre", "vache", "veau", "chameau", "cheval", "volaille", "autre"] },
  "head-count": { id: "head-count", type: "number", min: 1, max: 10000 },
  "livestock-age": { id: "livestock-age", type: "select", options: ["moins-1-an", "1-2-ans", "plus-2-ans"] },
  "agri-type": { id: "agri-type", type: "select", options: ["tracteur", "motoculteur", "remorque-agricole", "irrigation", "semoir-charrue", "moissonneuse", "pulverisateur", "autre"] },
  "construction-type": { id: "construction-type", type: "select", options: ["engin-chantier", "betonniere", "echafaudage", "compresseur", "groupe-electrogene", "coffrage", "outillage-btp", "autre"] },
  "horeca-type": { id: "horeca-type", type: "select", options: ["cuisine-pro", "refrigeration", "machine-cafe", "four-pro", "mobilier-restaurant", "bar", "vaisselle-pro", "autre"] },
  "office-type": { id: "office-type", type: "select", options: ["caisse-tpe", "presentoirs-rayonnages", "mobilier-bureau", "informatique-pro", "imprimante-copieur", "securite-video", "autre"] },
  "medical-type": { id: "medical-type", type: "select", options: ["dentaire", "mobilier-medical", "imagerie", "laboratoire", "paramedical", "esthetique", "autre"] },
  "stock-type": { id: "stock-type", type: "select", options: ["textile", "alimentaire", "cosmetique", "electronique", "menage", "jouets", "autre"] },
  "quantity": { id: "quantity", type: "number", min: 1, max: 10000000 },
  "course-subject": { id: "course-subject", type: "select", options: ["soutien-scolaire", "langues", "informatique", "musique", "sport-coaching", "cuisine", "conduite", "autre"] },
  "course-level": { id: "course-level", type: "select", options: ["primaire", "college", "lycee", "superieur", "adultes"] },
  "course-mode": { id: "course-mode", type: "select", options: ["domicile", "en-ligne", "chez-le-prof"] },
  "transport-type": { id: "transport-type", type: "select", options: ["demenagement", "livraison", "transport-marchandises", "transport-personnes", "camion-chauffeur", "autre"] },
  "transport-vehicle": { id: "transport-vehicle", type: "select", options: ["camion", "camionnette", "voiture", "autre"] },
  "trade": { id: "trade", type: "select", options: ["plomberie", "electricite", "peinture", "maconnerie", "menuiserie", "climatisation", "carrelage", "serrurerie", "reparation-electromenager", "autre"] },
  "service-mode": { id: "service-mode", type: "select", options: ["domicile", "atelier", "les-deux"] },
  "cleaning-type": { id: "cleaning-type", type: "select", options: ["menage-regulier", "grand-nettoyage", "repassage", "nettoyage-bureaux", "fin-chantier", "autre"] },
  "frequency": { id: "frequency", type: "select", options: ["ponctuel", "hebdomadaire", "quotidien"] },
  "event-service": { id: "event-service", type: "select", options: ["traiteur", "neggafa", "photographe-video", "dj-animation", "location-salle", "decoration", "location-materiel", "autre"] },
  "beauty-service": { id: "beauty-service", type: "select", options: ["coiffure", "maquillage", "esthetique", "henne", "onglerie", "autre"] },
} as const satisfies Record<string, FieldDef>;

export type CriterionId = keyof typeof FIELDS;
export const CRITERIA: Readonly<Record<CriterionId, FieldDef>> = FIELDS;
export const CRITERION_IDS = Object.keys(FIELDS) as CriterionId[];

const required = (id: CriterionId): Criterion => ({ ...FIELDS[id], required: true });
const optional = (id: CriterionId): Criterion => ({ ...FIELDS[id] });
const dossier = (id: CriterionId, options: { filter?: true } = {}): Criterion => ({ ...FIELDS[id], group: "dossier", ...options });

/** Motor vehicles for sale (Concession pack): dossier, buying guide, test drive, dealer storefront. */
export const VEHICLE_SALE_SUBCATEGORIES: readonly string[] = ["voitures", "utilitaires-camions", "motos-scooters"];

/** Dossier shared by the motor vehicles sold (cars, vans and trucks, motorbikes). */
const VEHICLE_DOSSIER = [
  dossier("first-hand", { filter: true }),
  dossier("service-history", { filter: true }),
  dossier("no-accident"),
  dossier("vehicle-papers"),
  dossier("vehicle-warranty", { filter: true }),
  dossier("warranty-months"),
  dossier("trade-in", { filter: true }),
  dossier("financing"),
  dossier("stock-ref"),
] as const;
const proRequired = (id: CriterionId): Criterion => ({ ...FIELDS[id], required: true, proOnly: true });
const proOptional = (id: CriterionId): Criterion => ({ ...FIELDS[id], proOnly: true });

export const CATEGORIES: readonly Category[] = [
  {
    id: "vehicules",
    subcategories: [
      { id: "voitures", categoryId: "vehicules", condition: "optional", criteria: [required("car-brand"), required("model"), required("year"), required("mileage"), required("fuel"), required("gearbox"), optional("fiscal-power"), optional("origin"), optional("body-type"), optional("doors"), optional("color"), ...VEHICLE_DOSSIER, dossier("car-equipment")] },
      { id: "location-voitures", categoryId: "vehicules", priceOptional: true, priceUnit: "day", proOnly: true, criteria: [required("car-brand"), required("model"), optional("year"), required("gearbox"), optional("fuel")] },
      { id: "motos-scooters", categoryId: "vehicules", condition: "optional", criteria: [required("moto-brand"), optional("model"), required("year"), optional("mileage"), required("engine-size"), ...VEHICLE_DOSSIER] },
      { id: "velos", categoryId: "vehicules", condition: "required", donationAllowed: true, criteria: [required("bike-type"), optional("bike-size"), optional("brand")] },
      { id: "utilitaires-camions", categoryId: "vehicules", condition: "optional", criteria: [required("utility-type"), required("car-brand"), optional("model"), required("year"), required("mileage"), required("fuel"), optional("gearbox"), ...VEHICLE_DOSSIER] },
      { id: "bateaux", categoryId: "vehicules", condition: "optional", criteria: [required("boat-type"), optional("year"), optional("engine-power")] },
      { id: "pieces-accessoires", categoryId: "vehicules", condition: "required", criteria: [required("part-type"), required("vehicle-kind"), optional("car-brand")] },
    ],
  },
  {
    id: "immobilier",
    sharedFilters: ["property-type", "surface", "rooms", "bedrooms"],
    cardFacts: ["surface", "rooms", "bedrooms"],
    subcategories: [
      { id: "vente", categoryId: "immobilier", criteria: [required("property-type"), required("surface"), optional("rooms"), optional("bedrooms"), optional("living-rooms"), optional("bathrooms"), optional("floor"), optional("standing"), optional("property-age"), optional("property-title"), optional("furnished"), optional("amenities"), proOptional("off-plan"), proOptional("building-permit"), proOptional("delivery-year"), proRequired("mandate"), proOptional("agency-reference"), proRequired("agency-fees"), proOptional("agency-fees-amount")] },
      { id: "location", categoryId: "immobilier", priceOptional: true, priceUnit: "month", criteria: [required("property-type"), required("surface"), optional("rooms"), optional("bedrooms"), optional("living-rooms"), optional("bathrooms"), optional("floor"), required("furnished"), optional("amenities"), optional("deposit"), optional("availability"), proRequired("mandate"), proOptional("agency-reference"), proRequired("agency-fees"), proOptional("agency-fees-amount")] },
      { id: "colocation", categoryId: "immobilier", priceUnit: "month", criteria: [required("room-type"), optional("flatmates"), optional("furnished"), optional("amenities"), optional("availability")] },
      { id: "location-vacances", categoryId: "immobilier", priceUnit: "night", criteria: [required("property-type"), required("guests"), optional("surface"), optional("bedrooms"), optional("bathrooms"), optional("amenities"), optional("min-nights"), optional("tourism-authorization"), proOptional("agency-reference")] },
    ],
  },
  {
    id: "electronique",
    subcategories: [
      { id: "telephones-objets-connectes", categoryId: "electronique", condition: "required", criteria: [required("phone-device-type"), required("phone-brand"), optional("model"), optional("storage"), optional("warranty")] },
      { id: "ordinateurs", categoryId: "electronique", condition: "required", criteria: [required("computer-type"), required("computer-brand"), optional("model"), optional("ram"), optional("storage"), optional("warranty")] },
      { id: "tablettes", categoryId: "electronique", condition: "required", criteria: [required("tablet-brand"), optional("model"), optional("storage"), optional("warranty")] },
      { id: "accessoires-electronique", categoryId: "electronique", condition: "required", donationAllowed: true, criteria: [required("accessory-type"), optional("brand"), optional("warranty")] },
      { id: "tv-photo-audio", categoryId: "electronique", condition: "required", criteria: [required("av-type"), optional("brand"), optional("model"), optional("warranty")] },
      { id: "consoles-jeux-video", categoryId: "electronique", condition: "required", criteria: [required("gaming-type"), required("platform"), optional("warranty")] },
    ],
  },
  {
    id: "maison-jardin",
    subcategories: [
      { id: "ameublement", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("furniture-type"), optional("material"), optional("color")] },
      { id: "electromenager", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("appliance-type"), optional("brand"), optional("warranty")] },
      { id: "decoration-artisanat", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("decor-type"), optional("material"), optional("handmade")] },
      { id: "koumiyas-decoratives", categoryId: "maison-jardin", condition: "required", adultsOnly: true, criteria: [optional("material"), optional("handmade")] },
      { id: "linge", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("linen-type"), optional("material")] },
      { id: "arts-de-la-table", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("tableware-type"), optional("material")] },
      { id: "bricolage", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("diy-type"), optional("brand")] },
      { id: "jardin", categoryId: "maison-jardin", condition: "required", donationAllowed: true, criteria: [required("garden-type")] },
    ],
  },
  {
    id: "mode",
    subcategories: [
      { id: "vetements", categoryId: "mode", condition: "required", donationAllowed: true, criteria: [required("audience"), required("clothing-type"), required("clothing-size"), optional("brand"), optional("color")] },
      { id: "tenues-traditionnelles", categoryId: "mode", condition: "required", donationAllowed: true, criteria: [required("audience"), required("traditional-type"), optional("clothing-size"), optional("color")] },
      { id: "chaussures", categoryId: "mode", condition: "required", donationAllowed: true, criteria: [required("audience"), required("shoe-type"), required("shoe-size"), optional("brand"), optional("color")] },
      { id: "sacs-accessoires", categoryId: "mode", condition: "required", donationAllowed: true, criteria: [required("fashion-accessory-type"), optional("audience"), optional("brand"), optional("color")] },
      { id: "montres-bijoux", categoryId: "mode", condition: "required", criteria: [required("jewelry-type"), optional("jewelry-material"), optional("audience"), optional("brand")] },
    ],
  },
  {
    id: "famille",
    subcategories: [
      { id: "equipement-bebe", categoryId: "famille", condition: "required", donationAllowed: true, criteria: [required("baby-type"), optional("brand"), optional("child-age")] },
      { id: "vetements-enfant", categoryId: "famille", condition: "required", donationAllowed: true, criteria: [required("child-clothing-type"), required("child-age"), optional("child-audience"), optional("brand"), optional("color")] },
      { id: "mobilier-enfant", categoryId: "famille", condition: "required", donationAllowed: true, criteria: [required("child-furniture-type"), optional("child-age"), optional("material")] },
    ],
  },
  {
    id: "loisirs",
    subcategories: [
      { id: "sport-plein-air", categoryId: "loisirs", condition: "required", donationAllowed: true, criteria: [required("sport-type"), optional("brand")] },
      { id: "instruments", categoryId: "loisirs", condition: "required", criteria: [required("instrument-type"), optional("brand")] },
      { id: "livres", categoryId: "loisirs", condition: "required", donationAllowed: true, criteria: [required("book-type"), optional("book-language")] },
      { id: "jeux-jouets", categoryId: "loisirs", condition: "required", donationAllowed: true, criteria: [required("toy-type"), optional("child-age")] },
      { id: "collection-antiquites", categoryId: "loisirs", condition: "optional", criteria: [required("collectible-type"), optional("material")] },
    ],
  },
  {
    id: "animaux",
    subcategories: [
      { id: "accessoires-animaux", categoryId: "animaux", condition: "required", donationAllowed: true, criteria: [required("pet-accessory-type"), optional("animal-type")] },
      { id: "animaux-compagnie", categoryId: "animaux", donationAllowed: true, criteria: [required("animal-type"), optional("breed"), optional("animal-age"), optional("animal-sex"), optional("vaccinated")] },
      { id: "betail-moutons", categoryId: "animaux", criteria: [required("livestock-type"), optional("head-count"), optional("livestock-age"), optional("breed")] },
    ],
  },
  {
    id: "materiel-pro",
    subcategories: [
      { id: "agricole-tracteurs", categoryId: "materiel-pro", condition: "optional", priceOptional: true, criteria: [required("agri-type"), optional("brand"), optional("year")] },
      { id: "btp", categoryId: "materiel-pro", condition: "optional", priceOptional: true, criteria: [required("construction-type"), optional("brand"), optional("year")] },
      { id: "chr", categoryId: "materiel-pro", condition: "optional", priceOptional: true, criteria: [required("horeca-type"), optional("brand")] },
      { id: "commerce-bureau", categoryId: "materiel-pro", condition: "optional", priceOptional: true, criteria: [required("office-type"), optional("brand")] },
      { id: "medical", categoryId: "materiel-pro", condition: "optional", priceOptional: true, criteria: [required("medical-type"), optional("brand"), optional("year")] },
      { id: "stocks-gros", categoryId: "materiel-pro", priceOptional: true, criteria: [required("stock-type"), optional("quantity")] },
    ],
  },
  {
    id: "services",
    subcategories: [
      { id: "cours", categoryId: "services", priceOptional: true, criteria: [required("course-subject"), optional("course-level"), optional("course-mode")] },
      { id: "demenagement-transport", categoryId: "services", priceOptional: true, criteria: [required("transport-type"), optional("transport-vehicle")] },
      { id: "travaux-reparations", categoryId: "services", priceOptional: true, criteria: [required("trade"), optional("service-mode")] },
      { id: "menage", categoryId: "services", priceOptional: true, criteria: [required("cleaning-type"), optional("frequency")] },
      { id: "evenements", categoryId: "services", priceOptional: true, criteria: [required("event-service"), optional("guests")] },
      { id: "beaute", categoryId: "services", priceOptional: true, criteria: [required("beauty-service"), optional("service-mode")] },
    ],
  },
  {
    id: "divers",
    subcategories: [
      { id: "autres", categoryId: "divers", condition: "optional", priceOptional: true, donationAllowed: true, criteria: [] },
    ],
  },
];

const categoryIndex = new Map(CATEGORIES.map((category) => [category.id, category]));
const subcategoryIndex = new Map(CATEGORIES.flatMap((category) => category.subcategories.map((subcategory) => [subcategory.id, subcategory] as const)));

export const CATEGORY_IDS: readonly string[] = CATEGORIES.map((category) => category.id);
export const SUBCATEGORY_IDS: readonly string[] = [...subcategoryIndex.keys()];

export function categoryById(id: string): Category | undefined {
  return categoryIndex.get(id);
}

/** Subcategory ids are unique across the tree (`categoryId` is on the object). */
export function subcategoryById(id: string): Subcategory | undefined {
  return subcategoryIndex.get(id);
}

/**
 * Whether ads may ever run beside a listing of this subcategory: never on an adults-only one
 * (decorative koumiyas, Google's weapons and knives policy). Every `adsEligible` writer applies it.
 */
export function subcategoryAllowsAds(id: string | undefined): boolean {
  return !(id && subcategoryById(id)?.adultsOnly);
}

/** False when the criterion depends on another one whose value does not open it. */
export function criterionApplies(criterion: Pick<Criterion, "showIf">, attributes: Readonly<Record<string, unknown>>): boolean {
  if (!criterion.showIf) return true;
  const value = attributes[criterion.showIf.id];
  return typeof value === "string" && criterion.showIf.values.includes(value);
}

export function criterionById(id: string): FieldDef | undefined {
  return Object.hasOwn(FIELDS, id) ? FIELDS[id as CriterionId] : undefined;
}

function criterionSchema(criterion: Criterion): z.ZodType {
  switch (criterion.type) {
    case "select":
      return z.enum(criterion.options ?? []);
    case "multiselect": {
      const options = criterion.options ?? [];
      return z
        .array(z.enum(options))
        .max(options.length)
        .refine((values) => new Set(values).size === values.length, { message: "duplicate option" });
    }
    case "number": {
      let schema = z.number().int();
      if (criterion.min !== undefined) schema = schema.min(criterion.min);
      if (criterion.max !== undefined) schema = schema.max(criterion.max);
      if (criterion.step !== undefined) schema = schema.multipleOf(criterion.step);
      return schema;
    }
    case "boolean":
      return z.boolean();
    case "text": {
      const text = z.string().trim().max(CRITERION_TEXT_MAX);
      return criterion.required ? text.min(1) : text;
    }
  }
}

export type CriteriaSchema = ReturnType<typeof buildCriteriaSchema>;

/**
 * Whose criteria: "individual" leaves the Pro-only ones out (an unknown key then), "pro" applies
 * their `required`, "any" accepts every criterion with the Pro-only ones optional (shape checks
 * that do not know the seller, such as the screening).
 */
export type CriteriaAudience = "individual" | "pro" | "any";

/** The criteria of `subcategory` a seller of `audience` fills in (the form's fields). */
export function criteriaFor(subcategory: Subcategory, audience: CriteriaAudience): readonly Criterion[] {
  return audience === "individual" ? subcategory.criteria.filter((criterion) => !criterion.proOnly) : subcategory.criteria;
}

// Every criterion is a known key whatever the audience: an individual's Pro-only value is refused
// by the publish readiness (`criterion_pro_only`), not reported as unknown.
function buildCriteriaSchema(subcategory: Subcategory, audience: CriteriaAudience) {
  const shape: Record<string, z.ZodType> = {};
  for (const criterion of subcategory.criteria) {
    const schema = criterionSchema(criterion);
    const required = criterion.required && (!criterion.proOnly || audience === "pro");
    shape[criterion.id] = required ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

const schemaCache = new Map<string, CriteriaSchema>();

/**
 * Strict Zod object for the `attributes` of a subcategory: required fields present, no unknown key,
 * select values among the option ids, integers within bounds, texts <= 80 chars. Throws for an
 * unknown subcategory id (check with `subcategoryById` first).
 */
export function criteriaSchema(subcategoryId: string, audience: CriteriaAudience = "any"): CriteriaSchema {
  const key = `${audience}:${subcategoryId}`;
  const cached = schemaCache.get(key);
  if (cached) return cached;
  const subcategory = subcategoryById(subcategoryId);
  if (!subcategory) throw new RangeError(`unknown subcategory: ${subcategoryId}`);
  const schema = buildCriteriaSchema(subcategory, audience);
  schemaCache.set(key, schema);
  return schema;
}

/**
 * Criteria a search may filter on: the subcategory's, or the category's `sharedFilters` before a
 * subcategory is chosen. Text criteria are left to the words.
 */
export function searchCriteria(categoryId: string | undefined, subcategoryId: string | undefined): readonly Criterion[] {
  const subcategory = subcategoryId ? subcategoryById(subcategoryId) : undefined;
  const criteria = subcategory ? subcategory.criteria : (categoryId ? categoryById(categoryId)?.sharedFilters : undefined)?.map(optional) ?? [];
  // The vehicle dossier stays out of the panel, but for the criteria marked `filter`.
  return criteria.filter((criterion) => criterion.type !== "text" && (!criterion.group || criterion.filter));
}
