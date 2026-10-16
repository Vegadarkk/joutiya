// Darija search lexicon (phase 4, design D4/D5). Client-safe data, no import.
// Each group lists spellings of one concept that a buyer may type in French, in Darija written in
// Latin letters with digits (arabizi: 3 = ع, 7 = ح, 9 = ق, 5 = خ, 8 = غ, 2 = ء) or in Arabic script.
// src/lib/search/settings.ts turns every group into mutual Meilisearch synonyms (the memory engine
// reads the same map) and src/lib/search/normalize.ts maps unknown arabizi variants onto the first
// Latin spelling of a group. Spellings are matched after case and accent folding (Meilisearch
// normalises synonyms like any text), so "télé" and "tele" are one spelling.
//
// Rules for new entries: a spelling belongs to one group only; never a word that is also a common
// unrelated word in another language or a whole place name (it would expand every query using it);
// no group above 50 spellings (Meilisearch limit per term); queries use synonyms only up to 3 words.

export interface LexiconGroup {
  /** Stable id (French gloss): tests and logs. */
  id: string;
  /** French words. */
  fr: readonly string[];
  /** Darija in Latin letters (arabizi); the first one is the canonical spelling (normalizeQuery). */
  latin: readonly string[];
  /** Arabic script (Darija and Modern Standard Arabic). */
  ar: readonly string[];
}

/**
 * Starter set written by hand (common classifieds vocabulary, conservative choices).
 * Licence: original work of the project.
 */
const STARTER: readonly LexiconGroup[] = [
  { id: "appartement", fr: ["appartement", "appart"], latin: ["chi9a", "chqa", "chiqa", "shi9a", "ch9a"], ar: ["شقة"] },
  { id: "voiture", fr: ["voiture"], latin: ["tomobil", "tomobile", "tonobil", "tonobile"], ar: ["طوموبيل", "طونوبيل", "سيارة"] },
  { id: "maison", fr: ["maison"], latin: ["dar"], ar: ["دار", "منزل"] },
  { id: "chambre", fr: ["chambre"], latin: ["bit"], ar: ["بيت", "غرفة"] },
  { id: "location", fr: ["location", "a louer"], latin: ["kra", "lkra", "l kra"], ar: ["كراء", "للكراء"] },
  { id: "vente", fr: ["vente", "a vendre"], latin: ["bi3", "lbi3", "l bi3"], ar: ["بيع", "للبيع"] },
  { id: "telephone", fr: ["telephone"], latin: ["tilifoun", "tilifon", "telefon"], ar: ["تيليفون", "هاتف"] },
  { id: "television", fr: ["television", "tele", "tv"], latin: ["tlfaza", "tilfaza"], ar: ["تلفاز", "تلفازة", "تلفزيون"] },
  { id: "refrigerateur", fr: ["refrigerateur", "frigo", "frigidaire"], latin: ["tlaja", "tellaja", "talaja"], ar: ["تلاجة", "ثلاجة"] },
  { id: "moto", fr: ["moto"], latin: ["motor", "motour"], ar: ["موطور", "دراجة نارية"] },
  { id: "velo", fr: ["velo"], latin: ["bichklit", "bechklit", "bichkilit"], ar: ["بشكليط"] },
  { id: "camion", fr: ["camion"], latin: ["kamyo", "kamio", "kamion"], ar: ["كاميو", "كاميون", "شاحنة"] },
  { id: "cuisine", fr: ["cuisine"], latin: ["kouzina", "kuzina", "kozina"], ar: ["كوزينة", "مطبخ"] },
  { id: "jardin", fr: ["jardin"], latin: ["jnan", "jarda"], ar: ["جنان", "جردة", "حديقة"] },
  { id: "terrasse", fr: ["terrasse"], latin: ["sto7", "stah", "stou7"], ar: ["سطح", "سطوح"] },
  { id: "immeuble", fr: ["immeuble"], latin: ["3imara", "imara"], ar: ["عمارة"] },
  { id: "magasin", fr: ["magasin"], latin: ["7anout", "hanout"], ar: ["حانوت", "محل", "دكان"] },
  { id: "cafe", fr: ["cafe"], latin: ["9ahwa", "qahwa", "kahwa"], ar: ["قهوة", "مقهى"] },
  { id: "bureau", fr: ["bureau"], latin: ["biro"], ar: ["بيرو", "مكتب"] },
  { id: "quartier", fr: ["quartier"], latin: ["7ouma", "houma"], ar: ["حومة"] },
  { id: "tapis", fr: ["tapis"], latin: ["zarbiya", "zerbiya", "zarbia"], ar: ["زربية"] },
  { id: "lit", fr: ["lit"], latin: ["namousiya", "namousia", "namosiya"], ar: ["ناموسية", "سرير"] },
  { id: "armoire", fr: ["armoire"], latin: ["mariyo", "maryo"], ar: ["ماريو", "خزانة"] },
  { id: "table", fr: ["table"], latin: ["tabla", "tbla"], ar: ["طبلة", "طاولة"] },
  { id: "chaise", fr: ["chaise"], latin: ["korsi", "koursi", "kursi"], ar: ["كرسي"] },
  { id: "vetements", fr: ["vetements", "vetement"], latin: ["7wayej", "hwayej", "hwayj"], ar: ["حوايج", "ملابس"] },
  { id: "chaussures", fr: ["chaussures", "chaussure"], latin: ["sbbat", "sebbat", "sabbat"], ar: ["صباط", "حذاء"] },
  { id: "montre", fr: ["montre"], latin: ["magana", "mgana"], ar: ["مكانة", "ساعة"] },
  { id: "sac", fr: ["sac"], latin: ["sak"], ar: ["صاك", "حقيبة"] },
  { id: "livre", fr: ["livre"], latin: ["ktab", "kteb"], ar: ["كتاب"] },
  { id: "mouton", fr: ["mouton"], latin: ["7ouli", "houli", "haouli", "7awli"], ar: ["حولي", "خروف"] },
  { id: "chevre", fr: ["chevre"], latin: ["m3za", "ma3za", "maaza"], ar: ["معزة", "ماعز"] },
  { id: "vache", fr: ["vache"], latin: ["bgra", "begra", "bagra"], ar: ["بقرة"] },
  { id: "cheval", fr: ["cheval"], latin: ["3awd", "aawd"], ar: ["حصان"] },
  { id: "chien", fr: ["chien"], latin: ["kelb", "kalb"], ar: ["كلب"] },
];

/**
 * Full lexicon from research/darija-synonyms.json (phase 4 research). DROP IT HERE: one
 * LexiconGroup per entry, its licence noted above the array. Until then the starter set applies.
 */
const RESEARCH: readonly LexiconGroup[] = [];

export const DARIJA_LEXICON: readonly LexiconGroup[] = [...STARTER, ...RESEARCH];

/**
 * Other spellings of city names (Latin, Arabic, historical names). Documents already carry the
 * French and Arabic names of their city and region (`placeText`); these variants reach them.
 */
export interface CityVariants {
  /** `src/config/regions.ts` slug (tests check it exists). */
  slug: string;
  variants: readonly string[];
}

export const CITY_VARIANTS: readonly CityVariants[] = [
  { slug: "casablanca", variants: ["casa", "dar beida", "dar el beida", "dar lbida", "كازا", "كازابلانكا"] },
  { slug: "marrakech", variants: ["marrakesh", "mrakech", "mrrakch", "marakech"] },
  { slug: "fes", variants: ["fez", "fas"] },
  { slug: "tanger", variants: ["tangier", "tangiers", "tanja", "طانجة"] },
  { slug: "tetouan", variants: ["titwan", "tetuan", "tettawen"] },
  { slug: "meknes", variants: ["miknas", "meknas"] },
  { slug: "el-jadida", variants: ["jadida", "mazagan"] },
  { slug: "al-hoceima", variants: ["hoceima", "alhoceima", "el hoceima", "lhoceima"] },
  { slug: "laayoune", variants: ["layoune", "laayoun", "el aaiun"] },
  { slug: "kenitra", variants: ["knitra"] },
  { slug: "sale", variants: ["sala"] },
  { slug: "mohammedia", variants: ["mohamedia", "fedala"] },
  { slug: "oujda", variants: ["wajda", "ouejda"] },
  { slug: "essaouira", variants: ["mogador", "swira"] },
  { slug: "chefchaouen", variants: ["chaouen", "chefchaoun", "chaoun"] },
  { slug: "beni-mellal", variants: ["bni mellal", "beni melal"] },
  { slug: "safi", variants: ["asfi"] },
  { slug: "errachidia", variants: ["rachidia", "ksar es souk"] },
  { slug: "temara", variants: ["tmara"] },
  { slug: "ksar-el-kebir", variants: ["ksar kbir"] },
  { slug: "mdiq", variants: ["m diq"] },
  { slug: "fnideq", variants: ["castillejos"] },
];
