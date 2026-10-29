import type { Condition } from "@/config/categories";
import { CITIES } from "@/config/regions";
import { CITY_LEXICON, citySpellings } from "@/config/search/darija";
import type { SellerTypeFilter } from "@/lib/search/params";
import { phraseTokens } from "./tokens";

// Vocabulary of the search interpreter ("Chercher en parlant", Carte vivante lot 4). Client-safe data.
// French, Arabic script and Darija in Latin letters (arabizi digits: 3 = ع, 7 = ح, 9 = ق). Phrases
// are matched on normalized words (tokens.ts), longest first; one phrase means one thing (the unit
// test rejects a phrase listed twice).
//
// Rules for edits:
// - A "thing" is a generic noun that names a subcategory or a category ("vélo", "tomobil",
//   "appartement"), never a brand or a model ("iphone", "golf", "dacia" stay words: the engine finds
//   them in titles, a filter would drop the right listings or keep the wrong ones).
// - A word with a second common meaning is left out, or `weak` (needs a rent or sale word: "dar"),
//   or guarded (a city that is also a word: "safi", "sale", "العيون" need "à", "f", "في", "ب").
// - Prices, distances and sorts are filters the visitor sees as chips; a vague word never becomes a
//   number ("pas cher" sorts by price, it never invents a ceiling).
// - Tarifit: the Rif pages fall back to French and no attested Latin spelling list was available;
//   none is guessed here.

export type ThingKind = "car" | "property";

export interface ThingEntry {
  kind: "thing";
  /** Subcategory, or the category alone when the word does not tell the subcategory. */
  subcategory?: string;
  category?: string;
  /** "car": rent words turn it into car rentals; "property": rent, sale or holiday words pick the offer. */
  family?: ThingKind;
  /** Criterion options the word implies ("vtt" -> bike-type vtt, "appartement" -> property-type). */
  criteria?: Readonly<Record<string, string>>;
  /** Only with a rent, sale or holiday word ("dar" is also a place-name word). */
  weak?: true;
}

export type Entry =
  | ThingEntry
  | { kind: "rent" }
  | { kind: "sale" }
  | { kind: "holiday" }
  | { kind: "city"; slug: string; guarded: boolean }
  | { kind: "conditions"; values: readonly Condition[]; /** Words of meaning ("neuf"): left in the text where the filter does not apply. */ keepWhenIdle?: true }
  | { kind: "donation" }
  | { kind: "photo" }
  | { kind: "seller"; type: SellerTypeFilter }
  | { kind: "cheap" }
  | { kind: "near" }
  /** Criterion options for some subcategories ("enfant": a child's bike, children's shoes). */
  | { kind: "modifier"; options: Readonly<Record<string, readonly [string, string]>> };

const car = (phrases: string[]): [string[], ThingEntry] => [phrases, { kind: "thing", subcategory: "voitures", family: "car" }];
const property = (type: string, phrases: string[], weak?: true): [string[], ThingEntry] => [phrases, { kind: "thing", category: "immobilier", family: "property", criteria: { "property-type": type }, ...(weak ? { weak } : {}) }];
const sub = (subcategory: string, phrases: string[], criteria?: Record<string, string>): [string[], ThingEntry] => [phrases, { kind: "thing", subcategory, ...(criteria ? { criteria } : {}) }];

const THINGS: [string[], ThingEntry][] = [
  // Vehicles.
  car(["voiture", "voitures", "automobile", "automobiles", "bagnole", "tomobil", "tomobile", "tomobila", "tonobil", "tomobilat", "طوموبيل", "طونوبيل", "سيارة", "سيارات"]),
  sub("location-voitures", ["voiture de location", "voitures de location", "location de voiture", "location de voitures", "location voiture", "location voitures"]),
  sub("motos-scooters", ["moto", "motos", "motocyclette", "motocyclettes", "scooter", "scooters", "mobylette", "mobylettes", "mobilette", "موطور", "موتور", "دراجة نارية", "دراجات نارية", "سكوتر"]),
  sub("velos", ["velo", "velos", "bicyclette", "bicyclettes", "bechklita", "bchklita", "bichklita", "bechkleta", "بشكليطة", "بيشكليطة", "دراجة هوائية", "دراجات هوائية"]),
  sub("velos", ["vtt"], { "bike-type": "vtt" }),
  sub("velos", ["bmx"], { "bike-type": "bmx" }),
  sub("velos", ["velo electrique", "velos electriques"], { "bike-type": "electrique" }),
  sub("utilitaires-camions", ["camion", "camions", "camionnette", "camionnettes", "fourgon", "fourgons", "شاحنة", "شاحنات", "كاميون", "كميون"]),
  sub("bateaux", ["bateau", "bateaux", "barque", "barques", "jet ski", "قارب", "قوارب"]),
  sub("pieces-accessoires", ["piece auto", "pieces auto", "piece detachee", "pieces detachees", "pieces de rechange", "قطع الغيار", "قطع غيار"]),
  sub("pieces-accessoires", ["pneu", "pneus", "jante", "jantes"], { "part-type": "pneus-jantes" }),
  // Real estate: the offer comes from a rent, sale or holiday word, else the whole category.
  property("appartement", ["appartement", "appartements", "appart", "apparts", "ch9a", "chi9a", "cha9a", "شقة", "شقق"]),
  property("studio", ["studio", "studios", "ستوديو"]),
  property("maison", ["maison", "maisons", "منزل", "منازل"]),
  property("maison", ["dar", "دار"], true),
  property("villa-riad", ["villa", "villas", "riad", "riads", "ryad", "فيلا", "فيلات"]),
  property("terrain-ferme", ["terrain", "terrains", "lot de terrain", "ferme", "fermes", "firma", "ضيعة"]),
  property("terrain-ferme", ["ard", "ارض"], true),
  property("local-commercial", ["local commercial", "locaux commerciaux", "7anout", "hanout", "حانوت", "محل تجاري"]),
  sub("colocation", ["colocation", "colocations", "coloc"]),
  // Electronics.
  sub("telephones-objets-connectes", ["telephone", "telephones", "gsm", "tilifon", "tilifoun", "telephon", "تليفون", "هاتف", "هواتف", "طيليفون"]),
  sub("telephones-objets-connectes", ["smartphone", "smartphones"], { "phone-device-type": "smartphone" }),
  sub("telephones-objets-connectes", ["montre connectee", "montres connectees", "smartwatch"], { "phone-device-type": "montre-connectee" }),
  sub("telephones-objets-connectes", ["ecouteurs"], { "phone-device-type": "ecouteurs" }),
  sub("ordinateurs", ["ordinateur", "ordinateurs", "pc", "حاسوب", "حواسيب", "كمبيوتر"]),
  sub("ordinateurs", ["ordinateur portable", "ordinateurs portables", "pc portable", "pc portables", "laptop", "laptops"], { "computer-type": "portable" }),
  sub("ordinateurs", ["pc de bureau", "pc bureau", "ordinateur de bureau"], { "computer-type": "bureau" }),
  sub("tablettes", ["tablette", "tablettes", "طابليت"]),
  sub("tv-photo-audio", ["tele", "television", "televiseur", "televiseurs", "tv", "تلفاز", "تلفزة", "تلفزيون"], { "av-type": "televiseur" }),
  sub("tv-photo-audio", ["appareil photo", "appareils photo"], { "av-type": "appareil-photo" }),
  sub("consoles-jeux-video", ["console", "consoles", "console de jeux", "jeu video", "jeux video"]),
  // Home.
  sub("ameublement", ["meuble", "meubles", "أثاث", "اثاث"]),
  sub("ameublement", ["salon marocain", "salons marocains", "صالون مغربي"], { "furniture-type": "salon-marocain" }),
  sub("ameublement", ["canape", "canapes"], { "furniture-type": "salon" }),
  sub("ameublement", ["armoire", "armoires"], { "furniture-type": "armoire-rangement" }),
  sub("ameublement", ["matelas"], { "furniture-type": "lit-matelas" }),
  sub("electromenager", ["electromenager"]),
  sub("electromenager", ["frigo", "frigos", "frigidaire", "refrigerateur", "refrigerateurs", "ثلاجة", "تلاجة", "فريجيدير"], { "appliance-type": "refrigerateur" }),
  sub("electromenager", ["machine a laver", "lave linge", "غسالة"], { "appliance-type": "lave-linge" }),
  sub("electromenager", ["lave vaisselle"], { "appliance-type": "lave-vaisselle" }),
  sub("electromenager", ["climatiseur", "climatiseurs", "clim", "مكيف"], { "appliance-type": "climatiseur" }),
  sub("electromenager", ["micro ondes"], { "appliance-type": "micro-ondes" }),
  sub("electromenager", ["aspirateur", "aspirateurs"], { "appliance-type": "aspirateur" }),
  sub("decoration-artisanat", ["tapis", "zarbia", "زربية"], { "decor-type": "tapis" }),
  // Fashion.
  sub("vetements", ["vetement", "vetements", "habits", "ملابس"]),
  sub("vetements-enfant", ["vetements enfant", "vetements enfants", "vetements bebe", "habits enfant", "habits enfants", "habits bebe", "ملابس الأطفال", "ملابس أطفال"]),
  sub("chaussures", ["chaussure", "chaussures", "sbabet", "صباط", "حذاء", "أحذية"]),
  sub("chaussures", ["baskets", "sneakers"], { "shoe-type": "baskets" }),
  sub("tenues-traditionnelles", ["caftan", "caftans", "kaftan", "قفطان"], { "traditional-type": "caftan" }),
  sub("tenues-traditionnelles", ["takchita", "takchitas", "تكشيطة"], { "traditional-type": "takchita" }),
  sub("tenues-traditionnelles", ["djellaba", "djellabas", "jellaba", "jellabas", "جلابة"], { "traditional-type": "djellaba" }),
  sub("sacs-accessoires", ["sac a main", "sacs a main"], { "fashion-accessory-type": "sac-a-main" }),
  sub("sacs-accessoires", ["sac a dos", "sacs a dos"], { "fashion-accessory-type": "sac-a-dos" }),
  sub("montres-bijoux", ["bijou", "bijoux"]),
  sub("montres-bijoux", ["montre", "montres"], { "jewelry-type": "montre" }),
  sub("montres-bijoux", ["bague", "bagues", "خاتم"], { "jewelry-type": "bague" }),
  // Family and leisure.
  sub("equipement-bebe", ["poussette", "poussettes"], { "baby-type": "poussette" }),
  sub("equipement-bebe", ["siege auto"], { "baby-type": "siege-auto" }),
  sub("equipement-bebe", ["lit bebe"], { "baby-type": "lit-bebe" }),
  sub("jeux-jouets", ["jouet", "jouets"]),
  sub("livres", ["livre", "livres", "كتاب", "كتب"]),
  sub("instruments", ["instrument de musique", "instruments de musique"]),
  sub("instruments", ["guitare", "guitares"], { "instrument-type": "guitare" }),
  sub("instruments", ["piano", "pianos"], { "instrument-type": "piano-clavier" }),
  // Animals.
  sub("animaux-compagnie", ["chien", "chiens", "chiot", "chiots", "kelb", "klab", "كلب", "كلاب", "جرو"], { "animal-type": "chien" }),
  sub("animaux-compagnie", ["chat", "chats", "chaton", "chatons", "mech", "قط", "قطة", "قطط"], { "animal-type": "chat" }),
  sub("animaux-compagnie", ["perroquet", "perroquets", "perruche", "perruches", "canari", "canaris"], { "animal-type": "oiseau" }),
  sub("betail-moutons", ["mouton", "moutons", "7awli", "hawli", "kebch", "kbch", "حولي", "كبش", "خروف"], { "livestock-type": "mouton" }),
  sub("betail-moutons", ["vache", "vaches", "بقرة"], { "livestock-type": "vache" }),
  sub("betail-moutons", ["chevre", "chevres", "me3za", "معزة"], { "livestock-type": "chevre" }),
  sub("betail-moutons", ["cheval", "chevaux", "حصان"], { "livestock-type": "cheval" }),
  // Services and local produce.
  sub("cours", ["cours particuliers", "cours particulier", "soutien scolaire", "cours de soutien"]),
  sub("demenagement-transport", ["demenagement", "demenageur", "demenageurs"]),
  sub("menage", ["femme de menage", "aide menagere"]),
  sub("travaux-reparations", ["plombier", "plombiers", "electricien", "electriciens", "menuisier", "menuisiers"]),
  sub("huile-olive", ["huile d olive", "زيت الزيتون"]),
  sub("miel", ["miel", "عسل"]),
  sub("amlou-pates-a-tartiner", ["amlou", "أملو"]),
];

const OTHER: [string[], Entry][] = [
  [["location", "louer", "a louer", "en location", "kra", "lkra", "l kra", "للكراء", "كراء", "الكراء", "للإيجار", "إيجار"], { kind: "rent" }],
  [["vente", "a vendre", "en vente", "lbi3", "l bi3", "للبيع"], { kind: "sale" }],
  [["location de vacances", "location vacances", "location saisonniere", "vacances", "pour les vacances", "estivale", "للعطلة", "كراء للعطل"], { kind: "holiday" }],
  // Conditions (src/config/categories.ts CONDITIONS).
  [["neuf", "neuve", "neufs", "neuves", "jdid", "jdida", "jamais utilise", "jamais servi", "sous blister", "avec etiquette", "جديد", "جديدة"], { kind: "conditions", values: ["new_tagged", "like_new"], keepWhenIdle: true }],
  [["comme neuf", "comme neuve", "etat neuf", "kif jdid", "بحال جديد"], { kind: "conditions", values: ["new_tagged", "like_new"], keepWhenIdle: true }],
  [["occasion", "d occasion", "occaz", "seconde main", "deuxieme main", "mosta3mal", "msta3mal", "mosta3mel", "مستعمل", "مستعملة"], { kind: "conditions", values: ["like_new", "very_good", "good"] }],
  [["bon etat", "en bon etat"], { kind: "conditions", values: ["new_tagged", "like_new", "very_good", "good"] }],
  [["tres bon etat", "en tres bon etat"], { kind: "conditions", values: ["new_tagged", "like_new", "very_good"] }],
  [["pour pieces", "pour piece", "en panne", "a reparer", "معطل", "معطلة"], { kind: "conditions", values: ["for_parts"], keepWhenIdle: true }],
  // Free, photos, sellers.
  [["gratuit", "gratuite", "gratuits", "gratuites", "gratuitement", "don", "dons", "a donner", "fabor", "fabour", "blach", "بلاش", "مجانا", "مجاني", "مجانية", "فابور"], { kind: "donation" }],
  [["avec photo", "avec photos", "avec des photos", "avec images", "مع صور", "مع الصور", "بالصور"], { kind: "photo" }],
  [["particulier", "particuliers", "entre particuliers", "de particulier", "de particulier a particulier", "vendeur particulier", "sans agence", "sans intermediaire", "bla samsar", "بدون سمسار", "بدون وسيط"], { kind: "seller", type: "individual" }],
  [["vendeur pro", "vendeurs pro", "vendeur professionnel", "vendeurs professionnels", "chez un pro", "chez un professionnel", "de professionnel", "par un professionnel"], { kind: "seller", type: "pro" }],
  // Cheap: price ascending, never a ceiling.
  [["pas cher", "pas chere", "pas chers", "pas cheres", "moins cher", "moins chere", "moins chers", "le moins cher", "les moins chers", "bon marche", "petit prix", "petits prix", "a petit prix", "prix bas", "cheap", "rkhis", "rkhisa", "rkhiss", "rkhas", "رخيص", "رخيصة", "أرخص"], { kind: "cheap" }],
  // Near the visitor: resolved by the browser position, after a click only.
  [["a cote", "a cote de moi", "a cote de chez moi", "pres de moi", "pres de chez moi", "pres d ici", "autour de moi", "proche de moi", "a proximite", "pas loin", "pas loin de moi", "dans le coin", "dans mon quartier", "qrib", "9rib", "qrib mni", "9rib mni", "qrib meni", "9rib meni", "qrib liya", "قريب", "قريب مني", "بالقرب مني", "قربي", "حدايا"], { kind: "near" }],
  // Who a garment, a pair of shoes or a bike is for.
  [["enfant", "enfants", "pour enfant", "pour enfants", "junior", "اطفال", "للأطفال", "طفل"], { kind: "modifier", options: { velos: ["bike-type", "enfant"], vetements: ["audience", "enfant"], chaussures: ["audience", "enfant"], "tenues-traditionnelles": ["audience", "enfant"] } }],
  [["femme", "femmes", "pour femme", "pour femmes", "نسائي", "نسائية"], { kind: "modifier", options: { vetements: ["audience", "femme"], chaussures: ["audience", "femme"], "tenues-traditionnelles": ["audience", "femme"], "sacs-accessoires": ["audience", "femme"], "montres-bijoux": ["audience", "femme"] } }],
  [["homme", "hommes", "pour homme", "pour hommes", "رجالي", "رجالية"], { kind: "modifier", options: { vetements: ["audience", "homme"], chaussures: ["audience", "homme"], "tenues-traditionnelles": ["audience", "homme"], "sacs-accessoires": ["audience", "homme"], "montres-bijoux": ["audience", "homme"] } }],
  [["electrique", "electriques"], { kind: "modifier", options: { velos: ["bike-type", "electrique"] } }],
];

/**
 * City spellings that are also everyday words ("sale", "safi" = enough, "العيون" = the eyes, "ميسور"
 * = affordable): a place only after "à", "f", "في" or an attached "ب"/"ف".
 */
const GUARDED_CITY_SPELLINGS: ReadonlySet<string> = new Set(
  ["sale", "sala", "safi", "tata", "assa", "fas", "taza", "el marsa", "العيون", "المرسى", "ميسور", "وزان", "بركان", "الحاجب", "الجديدة", "سلا", "اسا", "اسفي"].map((spelling) => phraseTokens(spelling).join(" ")),
);

/** Words of a place ("à Rabat", "f casa", "في الرباط"): they make a guarded city spelling a place. */
export const PLACE_WORDS: ReadonlySet<string> = new Set(["a", "au", "sur", "dans", "vers", "f", "fi", "في", "ب"]);

function cityEntries(): [string[], Entry][] {
  const out: [string[], Entry][] = [];
  const add = (slug: string, spellings: string[]) => {
    for (const spelling of spellings) {
      const key = phraseTokens(spelling).join(" ");
      out.push([[spelling], { kind: "city", slug, guarded: GUARDED_CITY_SPELLINGS.has(key) }]);
    }
  };
  for (const city of CITIES) add(city.slug, [city.nameFr, city.nameAr]);
  for (const city of CITY_LEXICON) add(city.slug, citySpellings(city));
  return out;
}

/**
 * Leftover words dropped once something was understood ("je cherche un vélo pour enfant": "je",
 * "cherche", "un" go). Never negations ("sans") or anything that narrows a search.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set(
  [
    "je", "j", "cherche", "recherche", "cherchons", "veux", "voudrais", "besoin", "achete", "acheter", "trouver", "svp", "stp", "merci", "bonjour",
    "de", "d", "du", "des", "la", "le", "les", "l", "un", "une", "pour", "a", "au", "aux", "en", "et", "ou", "avec", "sur", "dans", "qui", "que", "est", "moi", "mon", "ma", "mes", "tres",
    "bghit", "bghina", "baghi", "kan9leb", "kanqalleb", "kan9alleb", "3la", "ala", "f", "fi", "b", "dyal", "dial", "chi", "wahed", "w",
    "في", "من", "على", "عن", "و", "أبحث", "ابحث", "بغيت", "باغي", "ديال", "واحد", "شي", "أنا", "انا", "أريد", "اريد",
  ].map((word) => phraseTokens(word).join(" ")),
);

export interface PhraseEntry {
  tokens: readonly string[];
  entry: Entry;
  /** As listed (tests report it). */
  phrase: string;
}

/** Every phrase of the vocabulary, normalized; cities after the rest (a listed word wins). */
export function lexiconPhrases(): PhraseEntry[] {
  const out: PhraseEntry[] = [];
  for (const [phrases, entry] of [...THINGS, ...OTHER, ...cityEntries()]) {
    for (const phrase of phrases) {
      const tokens = phraseTokens(phrase);
      if (tokens.length > 0) out.push({ tokens, entry, phrase });
    }
  }
  return out;
}
