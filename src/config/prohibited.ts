// Prohibited objects and services (architecture §7 step 2, design D8). Matched by
// src/lib/moderation/prohibited.ts on `normalizeText` tokens (src/lib/text/normalize.ts): write the
// terms as people type them (FR, AR, darija, arabizi); accents, case and punctuation are folded,
// Latin plurals in -s/-x and the Arabic article / conjunction prefixes (ال، و، ب، ل، ف، ك) are
// folded by the matcher, multi-word phrases match as consecutive words. A term never matches inside a
// longer word ("drogue" does not hit "droguerie").
//
// `hard`: unambiguous in a classifieds context -> 422 `prohibited` field issue at publish.
// `soft`: has legitimate uses too -> `prohibited_soft` flag -> `needs_review`.
// Keep traps (notes-moderation.md) out of `hard`; the owner can move terms between the lists.
// A group with a `scope` is matched on listings of that category only: the job ad groups (fees
// asked from a candidate, discriminatory wording, minors; Code du travail arts. 9, 143, 480, 485)
// name words that are ordinary elsewhere ("caution" is a rental's deposit).
// Client-safe (no dependency).

export const PROHIBITED_GROUP_IDS = [
  "weapons",
  "drugs",
  "counterfeit",
  "stolen",
  "identity_documents",
  "human",
  "protected_species",
  "medicines",
  "hacking_piracy",
  "gambling",
  "inalienable_land",
  "job_scam",
  "job_discrimination",
  "job_minors",
] as const;
export type ProhibitedGroupId = (typeof PROHIBITED_GROUP_IDS)[number];

/** Category ids a group can be limited to. */
export type ProhibitedScope = "emploi";

export interface ProhibitedGroup {
  id: ProhibitedGroupId;
  hard: readonly string[];
  soft: readonly string[];
  /** Matched on listings of this category only (absent: everywhere). */
  scope?: ProhibitedScope;
}

export const PROHIBITED_GROUPS: readonly ProhibitedGroup[] = [
  {
    id: "weapons",
    hard: [
      "kalachnikov", "kalashnikov", "kalach", "kalash", "ak47", "ak 47", "glock", "arme a feu", "arme de guerre", "pistolet automatique",
      "pistolet a feu", "fusil a pompe", "fusil de chasse", "fusil d'assaut", "carabine", "revolver", "munitions", "cartouches 9mm",
      "balles reelles", "9mm", "calibre 12", "taser", "stun gun", "matraque telescopique", "poing americain", "couteau papillon",
      "arme blanche", "silencieux pour arme", "lance grenade", "explosif", "explosifs", "dynamite",
      "بندقية", "كلاشينكوف", "كلاشنكوف", "متفجرات", "سلاح ناري", "مسدس حقيقي",
    ],
    // Traps: مكحلة / mkohla (also a kohl pot), مسدس (also hexagonal), رشاش (also a sprinkler), grenade (fruit).
    // Koumiya / khanjar: allowed as decorative craft in their adults-only subcategory, which is
    // reviewed anyway; elsewhere a moderator moves or refuses the listing. Not كمية ("quantity").
    soft: ["arme", "pistolet", "fusil", "airsoft", "sabre", "epee", "machette", "poignard", "cran d'arret", "grenade", "beretta", "lacrymogene", "ferdi", "mkohla", "mkahla", "koumiya", "koumia", "koumya", "khanjar", "khenjar", "سلاح", "مسدس", "رشاش", "مكحلة", "قنبلة", "ذخيرة", "خنجر"],
  },
  {
    id: "drugs",
    hard: [
      "cocaine", "heroin", "cannabis", "haschich", "hachich", "hashish", "hashich", "zetla", "zatla", "marijuana", "marihuana", "ecstasy",
      "extasy", "mdma", "lsd", "crystal meth", "methamphetamine", "amphetamine", "stupefiant", "stupefiants", "space cake", "karkoubi",
      "qarqoubi", "9ar9oubi", "9er9oubi", "karkobi", "lkarkoubi",
      "كوكايين", "هيروين", "مخدرات", "قرقوبي", "ماريخوانا", "ماريجوانا", "اكستازي", "حبوب مهلوسة", "أفيون",
    ],
    // Traps: حشيش / l7chich (also lawn, "حشيش اصطناعي"), opium (perfume), weed (Weed Eater), heroine (female hero).
    soft: ["drogue", "heroine", "psychotrope", "kif", "chira", "ma3joun", "majoun", "coke", "hash", "weed", "opium", "hchich", "7chich", "lhchich", "l7chich", "حشيش", "شيرا"],
  },
  {
    id: "counterfeit",
    hard: [
      "contrefacon", "contrefait", "contrefaite", "first copy", "premiere copie", "copie originale", "copy original", "qualite aaa",
      "master copy", "master quality", "super fake", "mirror quality", "haute copie", "high copy", "copie haute qualite",
      "faux billets", "fausse monnaie", "billets contrefaits", "faux dirhams",
    ],
    // Traps: تقليد (also tradition), imitation (imitation cuir), faux (faux plafond, faux cils): not listed.
    soft: ["replique", "replica", "copie", "fake", "clone", "taqlid", "ta9lid", "tqlid", "تقليد"],
  },
  {
    id: "stolen",
    hard: [
      "icloud bloque", "icloud verrouille", "icloud lock", "icloud locked", "bloque icloud", "verrouille icloud", "marchandise volee",
      "voiture volee", "mesrou9", "mesrouq", "msrouq", "mesrouka", "msrouka", "mechfour", "mechfoura", "mchfour", "mchfoura",
      "مسروق", "مسروقة", "مشفور", "مشفورة",
    ],
    soft: ["vole", "volee", "sans papiers", "sans carte grise", "frp bloque"],
  },
  {
    id: "identity_documents",
    hard: [
      "faux passeport", "faux papiers", "fausse carte d'identite", "fausse cin", "faux permis", "permis sans examen", "permis bla examen",
      "permis bla imti7an", "visa garanti", "visa mdmoun", "visa madmoun", "contrat de travail a vendre", "contrat de travail garanti",
      "contrat de travail mdmoun", "faux diplome", "diplome sans etude", "diplome sans etudes", "passeport a vendre", "cin a vendre",
      "carte nationale a vendre", "carte de sejour a vendre", "titre de sejour garanti",
      "جواز سفر للبيع", "بيع جواز", "بطاقة وطنية للبيع", "رخصة بدون امتحان", "فيزا مضمونة", "عقد عمل للبيع", "عقد عمل مضمون",
      "شهادة مزورة", "وثائق مزورة", "جواز مزور", "بطاقة مزورة",
    ],
    // Traps: passeport (pochette passeport), cin (asked for rentals), diplome (= diplômé), permis de conduire (jobs): not listed.
    soft: ["visa", "titre de sejour", "carte de sejour"],
  },
  {
    id: "human",
    hard: [
      "escort", "escorte", "escort girl", "massage erotique", "massage sensuel", "massage intime", "massage tantrique", "happy end",
      "happy ending", "body body", "body to body", "plan cul", "plan q", "rencontre coquine", "rencontre discrete", "service sexuel",
      "services sexuels", "prostitution", "prostituee", "sugar daddy", "sugar baby", "sugar mommy", "camgirl", "cam girl", "nudes", "9a7ba",
      "qahba", "97ba", "kahba", "mariage blanc", "fille a vendre", "enfant a vendre", "bebe a vendre", "rein a vendre", "vente de rein",
      "vendre mon rein", "vente d'organe", "vente d'organes", "organe a vendre",
      "كلية للبيع", "بيع كلية", "بيع الأعضاء", "خدمات جنسية", "دعارة", "مساج حميمي", "مساج جنسي", "علاقة جنسية", "زواج مقابل", "طفل للبيع",
      "رضيع للبيع",
    ],
    // Traps: massage (legit beauty service), intime (hygiène intime), sensuel (perfumes), adulte (taille adulte): not listed.
    soft: ["rencontre", "coquin", "coquine", "libertin", "libertine"],
  },
  {
    id: "protected_species",
    hard: [
      "ivoire d'elephant", "defense d'elephant", "corne de rhinoceros", "peau de leopard", "peau de tigre", "peau de panthere",
      "peau de python", "macaque", "magot", "singe magot", "chardonneret", "ma9nin", "maknin", "mqnin", "me9nine", "mkanine", "fennec",
      "guepard", "varan", "gazelle dorcas", "gazelle vivante", "oeuf de tortue", "oeufs de tortue", "aigle royal",
      "المقنين", "مقنين", "فنك", "عاج الفيل", "ورل",
    ],
    // Traps: ivoire / عاج (colour, Côte d'Ivoire = ساحل العاج), gazelle (Adidas), python (language), cobra (brand): soft or absent.
    soft: ["ivoire", "tortue", "singe", "perroquet", "faucon", "cameleon", "herisson", "ecaille", "babouin", "fakroun", "fekroun", "عاج", "صقر", "قرد", "سلحفاة", "فقرون"],
  },
  {
    id: "medicines",
    hard: [
      "rivotril", "tramadol", "xanax", "lyrica", "subutex", "viagra", "cialis", "ritaline", "ritalin", "ozempic", "saxenda", "wegovy",
      "misoprostol", "cytotec", "pilule abortive", "pilules abortives", "avortement", "morphine", "methadone", "ketamine", "steroide",
      "steroides", "anabolisant", "anabolisants", "dianabol", "clenbuterol", "trenbolone", "winstrol", "deca durabolin",
      "hormone de croissance", "hgh",
      "إجهاض", "حبوب الإجهاض", "سيتوتيك", "ترامادول", "ريفوتريل", "زاناكس", "ليريكا", "فياغرا", "فياجرا", "منشطات",
    ],
    // Traps: insuline (pompe à insuline = device), medicament (boîte à médicaments): soft or absent.
    soft: ["antibiotique", "antibiotiques", "codeine", "botox", "ordonnance", "insuline", "testosterone", "دواء", "دوا", "أدوية", "انسولين", "حبوب التخسيس", "هرمونات"],
  },
  {
    id: "hacking_piracy",
    hard: [
      "abonnement iptv", "iptv 12 mois", "iptv 1 an", "serveur iptv", "code iptv", "codes iptv", "iptv premium", "netflix pas cher", "cccam",
      "cardsharing", "card sharing", "decodeur pirate", "cracke", "crackee", "keygen", "piratage", "pirater", "hack compte", "hack facebook",
      "hack instagram", "hack whatsapp", "hack wifi", "hacker un compte", "espionner", "espionnage telephone", "logiciel espion", "spyware",
      "keylogger", "fullz", "carte bancaire clonee", "cartes clonees", "phishing", "ddos", "botnet",
      "اختراق حسابات", "اختراق واتساب", "اختراق فيسبوك", "تجسس على الهاتف", "برنامج تجسس", "اشتراك iptv", "سيرفر iptv", "كود iptv", "تهكير",
    ],
    // Traps: cracked (screen), skimmer (pool), flash (USB, camera), licence (degree), activation, espion (caméra espion): soft or absent.
    soft: ["iptv", "compte netflix", "crack", "cracked", "hack", "carding", "اختراق"],
  },
  {
    id: "gambling",
    hard: [
      "1xbet", "1x bet", "betwinner", "melbet", "linebet", "22bet", "1win", "casino en ligne", "casinos en ligne", "paris sportifs en ligne",
      "jeux d'argent", "machine a sous", "machines a sous", "poker en ligne", "compte de pari",
      "قمار", "كازينو اون لاين", "كازينو أونلاين", "مراهنات",
    ],
    // Traps: pari (plural "paris" = the city), poker (chip sets): not listed.
    soft: ["casino", "paris sportifs", "loterie", "tombola", "jackpot", "كازينو", "رهان"],
  },
  {
    // Collective (soulaliyate, laws 62-17 and 63-17) and habous land cannot be sold (Agence pack
    // design §1). Review only: a habous property is rented out lawfully, and a listing may name the
    // land's past status.
    id: "inalienable_land",
    hard: [],
    soft: ["terre collective", "terres collectives", "terrain collectif", "soulaliyate", "soulalia", "soulaliya", "habous", "أراضي الجموع", "أرض الجموع", "أرض سلالية", "أراضي سلالية", "حبوس", "أرض الحبوس"],
  },
  {
    // Job ads only (Emploi frame of 2026-10-30): a candidate never pays (Code du travail arts. 480,
    // 485). Fees, deposits, advances, a visa against money, a top-up or a cash transfer asked in a
    // job ad: review only ("aucun frais de dossier" is honest wording).
    id: "job_scam",
    hard: [],
    soft: [
      "frais de dossier", "frais d'inscription", "frais de formation", "formation payante", "caution", "acompte", "avance de frais", "verser une avance",
      "envoyer une avance", "payer pour", "payez pour", "paiement avant", "visa contre", "garantie de visa", "visa assure", "recharge", "western union",
      "wafacash", "cash plus", "moneygram",
      "رسوم الملف", "رسوم التسجيل", "واجب التسجيل", "دفع مسبق", "تسبيق", "ضمانة الفيزا", "مقابل الفيزا", "ريشارج", "ويسترن يونيون", "وافاكاش", "كاش بلوس",
    ],
    scope: "emploi",
  },
  {
    // Job ads only: a requirement on sex, age, looks, marital status, religion, origin or handicap
    // (Code du travail art. 9) goes to a moderator; a genuine occupational requirement is theirs to judge.
    id: "job_discrimination",
    hard: [],
    soft: [
      "homme seulement", "femme seulement", "homme uniquement", "femme uniquement", "reserve aux hommes", "reserve aux femmes", "uniquement des hommes",
      "uniquement des femmes", "pas de femme", "jeune fille", "jolie fille", "belle fille", "bonne presentation", "belle presentation", "physique agreable",
      "sans voile", "sans hijab", "non voilee", "moins de 25 ans", "moins de 30 ans", "moins de 35 ans", "moins de 40 ans", "age maximum", "age maximal",
      "age limite", "celibataire", "sans enfant", "non mariee", "non marie", "musulman uniquement", "musulmane uniquement", "non musulman", "marocain uniquement",
      "marocaine uniquement", "pas de noir", "pas d'africain", "pas de subsaharien", "sans handicap", "pas de handicap",
      "رجال فقط", "نساء فقط", "ذكور فقط", "اناث فقط", "للرجال فقط", "للنساء فقط", "عازب", "عازبة", "غير متزوج", "غير متزوجة", "بدون أطفال", "مظهر جميل",
      "حسنة المظهر", "أقل من 25 سنة", "أقل من 30 سنة", "أقل من 35 سنة", "أقل من 40 سنة", "بدون حجاب", "غير محجبة", "محجبة فقط", "مسلم فقط", "مسلمة فقط",
      "مغربي فقط", "مغربية فقط",
    ],
    scope: "emploi",
  },
  {
    // Job ads only: work under 15 is forbidden, 15-18 restricted and domestic work under 18 banned
    // (Code du travail art. 143, loi 19-12). "mineur" is also a miner, "petite fille" a daughter: review.
    id: "job_minors",
    hard: [],
    soft: [
      "mineur", "mineure", "petite bonne", "petite fille", "petit garcon", "moins de 18 ans", "moins de 16 ans", "moins de 15 ans", "moins de 14 ans",
      "a partir de 12 ans", "a partir de 13 ans", "a partir de 14 ans", "a partir de 15 ans", "des 12 ans", "des 13 ans", "des 14 ans", "des 15 ans",
      "قاصر", "قاصرة", "قاصرين", "أقل من 18 سنة", "أقل من 16 سنة", "أقل من 15 سنة", "خدامة صغيرة", "بنت صغيرة", "طفلة للعمل", "طفل للعمل",
    ],
    scope: "emploi",
  },
];

export function prohibitedGroupById(id: string): ProhibitedGroup | undefined {
  return PROHIBITED_GROUPS.find((group) => group.id === id);
}
