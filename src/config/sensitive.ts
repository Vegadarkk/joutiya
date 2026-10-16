// Sensitive personal data in listing texts (architecture §7 step 3, Russmedia; design D8). Detected
// by src/lib/moderation/sensitive.ts: patterns (identity, bank and card numbers) plus vocabulary on
// `normalizeText` tokens, same folding rules as src/config/prohibited.ts. Any hit is a soft signal
// (`sensitive_text` -> needs_review): the advertiser declares `self` / `explicit_consent` and a
// moderator checks. Client-safe (no dependency).
//
// Context of a vocabulary entry (window = SENSITIVE_WINDOW tokens on each side):
//   "always"                 the word alone is enough (orientation, slurs, discriminatory phrases)
//   "person"                 needs a person marker nearby ("ma mere", "والدي", "khti", "decede"...)
//   "person_or_restriction"  person marker or a restriction marker ("uniquement", "فقط", "ghir"...)
// Product vocabulary (hijab, coran, tapis amazigh, fauteuil roulant, enceinte) is deliberately absent:
// it describes goods, not a person. Third-party names are out of scope (no NER).

export const SENSITIVE_CATEGORY_IDS = ["id_number", "bank_account", "card_number", "health", "religion", "ethnicity", "politics", "sexual_orientation"] as const;
export type SensitiveCategoryId = (typeof SENSITIVE_CATEGORY_IDS)[number];

export type SensitiveContext = "always" | "person" | "person_or_restriction";

export interface SensitiveVocabulary {
  id: Extract<SensitiveCategoryId, "health" | "religion" | "ethnicity" | "politics" | "sexual_orientation">;
  context: SensitiveContext;
  terms: readonly string[];
}

/** Tokens on each side of a term in which a marker counts. */
export const SENSITIVE_WINDOW = 8;

export const SENSITIVE_VOCABULARY: readonly SensitiveVocabulary[] = [
  {
    id: "health",
    context: "person",
    terms: [
      "cancer", "sida", "vih", "hiv", "seropositif", "seropositive", "diabete", "diabetique", "epilepsie", "epileptique", "schizophrene",
      "schizophrenie", "bipolaire", "depression", "depressif", "depressive", "autiste", "autisme", "trisomie", "trisomique", "handicap",
      "handicape", "handicapee", "paralyse", "paralysee", "alzheimer", "parkinson", "tuberculose", "hepatite", "asthme", "asthmatique",
      "dialyse", "chimiotherapie", "chimio", "psychiatrique", "hospitalise", "hospitalisee", "maladie", "malade", "sourd", "sourde",
      "aveugle", "muet", "muette",
      "سرطان", "سيدا", "ايدز", "سكري", "صرع", "اعاقة", "معاق", "معاقة", "مريض", "مريضة", "مرض", "شلل", "مشلول", "توحد", "اكتئاب", "فصام",
      "غسيل الكلى", "علاج كيميائي", "ضرير", "اعمى", "اصم",
      "mrid", "mrida", "mrad", "mo3a9", "mou3aq", "m3a9", "saratan",
    ],
  },
  {
    id: "religion",
    context: "person_or_restriction",
    terms: [
      "musulman", "musulmane", "chretien", "chretienne", "juif", "juive", "athee", "pratiquant", "pratiquante",
      "voilee", "non voilee", "sans voile", "mohajaba", "m7ajba", "mhajba", "chiite", "sunnite",
      "مسلم", "مسلمة", "مسيحي", "مسيحية", "يهودي", "يهودية", "ملحد", "محجبة", "غير محجبة", "متدين", "متدينة", "شيعي", "سني",
    ],
  },
  {
    id: "ethnicity",
    context: "person",
    terms: [
      "amazigh", "berbere", "arabe", "africain", "africaine", "subsaharien", "subsaharienne", "sahraoui", "sahraouie", "rifain", "rifaine",
      "senegalais", "senegalaise", "ivoirien", "ivoirienne", "malien", "malienne", "congolais", "congolaise", "camerounais", "guineen",
      "nigerian", "etranger", "etrangere", "marocain", "marocaine",
      "أمازيغي", "أمازيغية", "أفريقي", "أفريقية", "أفارقة", "أجنبي", "أجنبية", "أجانب", "صحراوي", "ريفي",
    ],
  },
  {
    id: "ethnicity",
    context: "always",
    terms: [
      // Discriminatory conditions and slurs
      "marocains uniquement", "pour marocains", "etrangers uniquement", "pas d'etrangers", "pas d'africains", "pas de noirs", "pas de subsahariens",
      "sans africains", "africains interdits", "negre", "negres", "negresse", "zanji",
      "للمغاربة فقط", "ممنوع الأجانب", "ممنوع الأفارقة", "زنجي", "عزي",
    ],
  },
  {
    id: "politics",
    context: "person_or_restriction",
    terms: ["communiste", "islamiste", "salafiste", "gauchiste", "militant", "militante", "opposant", "opposante", "dissident", "manifestant", "pjd", "usfp", "سلفي", "علماني", "مناضل", "حزب", "نقابي"],
  },
  {
    id: "politics",
    context: "always",
    terms: ["polisario", "sioniste", "sionistes", "hirak", "makhzen", "البوليساريو", "صهيوني", "حراك"],
  },
  {
    id: "sexual_orientation",
    context: "always",
    terms: [
      "gay", "gays", "homosexuel", "homosexuelle", "homosexuels", "lesbienne", "lesbiennes", "lgbt", "lgbtq", "lgbtqi", "transgenre", "transsexuel",
      "transsexuelle", "bisexuel", "bisexuelle", "queer", "zamel", "zamla",
      "مثلي", "مثلية", "مثليين", "شاذ", "شاذة", "لواط", "سحاق",
    ],
  },
];

/** Someone identified by the text: kinship, death, first person (FR, AR, darija / arabizi). */
export const PERSON_MARKERS: readonly string[] = [
  "ma mere", "mon pere", "ma femme", "mon mari", "mon fils", "ma fille", "mon frere", "ma soeur", "ma grand mere", "mon grand pere",
  "mon oncle", "ma tante", "mon enfant", "mes enfants", "mon bebe", "mon epoux", "mon epouse", "feu mon", "feue ma", "defunt", "defunte",
  "decede", "decedee", "mon proche", "mon voisin", "ma voisine", "mon ami", "mon amie", "je suis", "moi meme",
  "والدي", "والدتي", "امي", "ابي", "ابني", "بنتي", "ابنتي", "زوجتي", "زوجي", "اخي", "اختي", "جدي", "جدتي", "عمي", "خالي", "خالتي", "عمتي",
  "رحمه الله", "رحمها الله", "الله يرحمه", "الله يرحمها", "المرحوم", "المرحومة", "متوفى", "متوفي", "انا",
  "mama", "baba", "khti", "khouya", "khoya", "weldi", "wldi", "benti", "bnti", "mrati", "rajli", "jdi", "jdati", "3ammi", "khali", "khalti",
  "lmarhoum", "lmarhouma", "allah yrahmo", "allah yrhmo", "lah yrhmo", "lah yrahmo", "allah yrahmha", "lah yrhmha", "ana",
];

/** A condition on who may buy or rent: the sensitive word then describes a person, not a product. */
export const RESTRICTION_MARKERS: readonly string[] = [
  "uniquement", "seulement", "exclusivement", "reserve a", "reservee a", "reserve aux", "reservee aux", "de preference", "interdit aux",
  "interdite aux", "pas de", "sauf", "obligatoire", "obligatoirement", "exige", "exigee",
  "فقط", "حصريا", "يفضل", "ممنوع", "لا نقبل", "ghir", "ghi", "bla", "mamnou3",
];

/**
 * Letter groups that precede 6-7 digits in ordinary listing text (currency, units, references):
 * never an identity number. Lower case, compared after normalisation.
 */
export const ID_NUMBER_STOPLIST: ReadonlySet<string> = new Set([
  "dh", "dhs", "mad", "km", "kg", "g", "go", "gb", "mo", "to", "tb", "cv", "ch", "w", "kw", "v", "l", "ml", "m", "cm", "mm", "n", "no", "ref",
  "lot", "bp", "cp", "tel", "fix", "gsm", "imei", "sn", "ps", "rs", "eur", "usd", "ht", "ttc", "an", "ans", "h", "hz", "ghz", "mhz", "px", "mp",
]);
