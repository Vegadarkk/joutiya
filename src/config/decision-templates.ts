// Decision templates (art. 17 DSA statement of reasons, design phase-5 D13). One template fixes the
// measure, the target types it applies to, the ground (legal or contractual, `ref` <= 64
// characters) and the statement texts in French and Arabic: the facts found and why they are
// illegal or incompatible with the terms. The moderator may add their own words ("details"), quoted
// as written. Client-safe: the back office lists the templates, the mails render them.
// Neutral host wording: the platform hosts the content, the author answers for it.

export const DECISION_ACTIONS = ["remove", "restrict_visibility", "restore", "no_action", "warn", "suspend_account", "ban"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** Measures that restrict the affected user: statement of reasons (decisionNotice) and appeal. */
export const RESTRICTIVE_ACTIONS: readonly DecisionAction[] = ["remove", "restrict_visibility", "warn", "suspend_account", "ban"];
/** Measures applied to an account (the sanctions ladder, D14). */
export const SANCTION_ACTIONS = ["warn", "suspend_account", "ban"] as const;
export type SanctionAction = (typeof SANCTION_ACTIONS)[number];
export const SUSPENSION_DAYS = [7, 30] as const;
export type SuspensionDays = (typeof SUSPENSION_DAYS)[number];

export const DECISION_TARGET_TYPES = ["listing", "user", "message", "review"] as const;
export type DecisionTargetType = (typeof DECISION_TARGET_TYPES)[number];

export interface DecisionText {
  fr: string;
  ar: string;
}

export interface DecisionTemplate {
  id: string;
  /** Back-office label (French only, D24). */
  label: string;
  action: DecisionAction;
  targets: readonly DecisionTargetType[];
  /** moderationDecisions.ground: legal ground (illegal) or terms clause (terms). */
  ground: { type: "illegal" | "terms"; ref: string };
  /** Facts and circumstances relied on (17(3)(b)); `{days}` is the suspension length. */
  facts: DecisionText;
  /** Why the content is illegal or incompatible with the terms (17(3)(d)/(e)). */
  explanation: DecisionText;
  /** The reports this decision closes: founded (actioned) or unfounded (dismissed). */
  outcome: "founded" | "unfounded";
  /** Account sanction the back office proposes with a content decision (D14): none, the next ladder step, a ban. */
  defaultSanction: "none" | "next" | "ban";
  /** Confirms P0 content (minors, terrorism, threat): the account is banned at once (AF §7 step 6). */
  p0?: boolean;
  /** Suspension length of the suspend templates. */
  durationDays?: SuspensionDays;
  /** The moderator must explain in their own words (at least DETAILS_MIN characters). */
  detailsRequired?: boolean;
  /** Not offered in the back-office list (used by the server itself: authority orders, appeal reversals). */
  internal?: boolean;
}

export const DETAILS_MIN = 10;
export const DETAILS_MAX = 1000;

const LISTING: readonly DecisionTargetType[] = ["listing"];
const MESSAGE: readonly DecisionTargetType[] = ["message"];
const USER: readonly DecisionTargetType[] = ["user"];
const REVIEW: readonly DecisionTargetType[] = ["review"];
const ALL: readonly DecisionTargetType[] = ["listing", "user", "message", "review"];

const RULES = "CGU, règles de publication";
const PROHIBITED = "CGU, objets et services interdits";
const CONDUCT = "CGU, comportement des utilisateurs";
const SANCTIONS = "CGU, sanctions graduées";
const REVIEWS = "CGU, avis utilisateurs";

const NO_BREACH: DecisionText = {
  fr: "après examen, le contenu signalé ne nous paraît ni illicite ni contraire à nos conditions générales d'utilisation",
  ar: "بعد الفحص، لا يبدو لنا أن المحتوى المبلَّغ عنه غير قانوني أو مخالف لشروط الاستخدام العامة",
};

export const DECISION_TEMPLATES = [
  // ---- Listings -------------------------------------------------------------------------------
  {
    id: "listing.remove.prohibited",
    label: "Retrait : objet ou service interdit",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: PROHIBITED },
    facts: { fr: "l'annonce propose un objet ou un service interdit sur Aalan", ar: "يعرض الإعلان غرضًا أو خدمة ممنوعة على Aalan" },
    explanation: {
      fr: "nos conditions générales interdisent la vente de ces objets et services (voir la page « Objets interdits »)",
      ar: "تمنع شروطنا العامة بيع هذه الأغراض والخدمات (انظر صفحة «الأغراض الممنوعة»)",
    },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "listing.remove.scam",
    label: "Retrait : arnaque ou tentative d'escroquerie",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: "CGU, modération (arnaques)" },
    facts: {
      fr: "l'annonce présente des signes d'arnaque (paiement demandé d'avance, objet inexistant, prix irréaliste ou contact hors d'Aalan)",
      ar: "يحمل الإعلان مؤشرات احتيال (طلب الدفع مسبقًا، غرض غير موجود، سعر غير واقعي أو تواصل خارج Aalan)",
    },
    explanation: {
      fr: "nos conditions générales interdisent les annonces trompeuses destinées à obtenir un paiement ou des données",
      ar: "تمنع شروطنا العامة الإعلانات المضللة التي تهدف إلى الحصول على أداء أو على بيانات",
    },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "listing.remove.counterfeit",
    label: "Retrait : contrefaçon",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: `${PROHIBITED} (contrefaçon)` },
    facts: { fr: "l'annonce semble proposer une contrefaçon ou une copie d'une marque", ar: "يبدو أن الإعلان يعرض منتجًا مقلَّدًا أو نسخة من علامة تجارية" },
    explanation: { fr: "nos conditions générales interdisent la vente de contrefaçons", ar: "تمنع شروطنا العامة بيع المنتجات المقلَّدة" },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "listing.remove.misleading",
    label: "Retrait : annonce trompeuse",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: `${RULES} (exactitude)` },
    facts: { fr: "la description, le prix ou les photos ne correspondent pas au bien proposé", ar: "الوصف أو السعر أو الصور لا تطابق المنتج المعروض" },
    explanation: { fr: "nos conditions générales exigent une annonce exacte et sincère", ar: "تشترط شروطنا العامة أن يكون الإعلان دقيقًا وصادقًا" },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "listing.remove.personal_data",
    label: "Retrait : données personnelles d'un tiers",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: `${RULES} (données d'un tiers)` },
    facts: {
      fr: "l'annonce publie des données personnelles d'une autre personne (photo reconnaissable, nom ou numéro) sans son accord",
      ar: "ينشر الإعلان بيانات شخصية لشخص آخر (صورة يمكن التعرف عليه فيها أو اسم أو رقم) دون موافقته",
    },
    explanation: {
      fr: "nos conditions générales interdisent de publier les données d'un tiers sans son consentement",
      ar: "تمنع شروطنا العامة نشر بيانات شخص آخر دون موافقته",
    },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "listing.remove.sexual",
    label: "Retrait : contenu sexuel ou nudité",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: "CGU, contenus interdits" },
    facts: { fr: "l'annonce contient des photos ou des textes à caractère sexuel", ar: "يحتوي الإعلان على صور أو نصوص ذات طابع جنسي" },
    explanation: { fr: "nos conditions générales interdisent les contenus sexuels et la nudité", ar: "تمنع شروطنا العامة المحتويات الجنسية والعري" },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "listing.remove.spam",
    label: "Retrait : spam, doublon ou mauvaise catégorie",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: RULES },
    facts: {
      fr: "l'annonce est un spam, un doublon d'une autre annonce ou n'est pas dans la bonne catégorie",
      ar: "الإعلان رسالة مزعجة أو نسخة مكررة من إعلان آخر أو ليس في الفئة المناسبة",
    },
    explanation: { fr: "nos conditions générales demandent une seule annonce par bien, dans la bonne catégorie", ar: "تطلب شروطنا العامة إعلانًا واحدًا لكل منتج في الفئة المناسبة" },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "listing.remove.p0",
    label: "Retrait P0 confirmé : contenu illicite grave (bannissement)",
    action: "remove",
    targets: LISTING,
    ground: { type: "illegal", ref: "Code pénal (contenu illicite grave)" },
    facts: {
      fr: "l'annonce contient un contenu illicite grave (mise en danger de mineurs, terrorisme ou menace de violence)",
      ar: "يحتوي الإعلان على محتوى غير قانوني خطير (تعريض قاصرين للخطر أو إرهاب أو تهديد بالعنف)",
    },
    explanation: { fr: "ce contenu est interdit par la loi et par nos conditions générales", ar: "هذا المحتوى ممنوع بموجب القانون وبموجب شروطنا العامة" },
    outcome: "founded",
    defaultSanction: "ban",
    p0: true,
  },
  {
    id: "listing.remove.other",
    label: "Retrait : autre motif (à préciser)",
    action: "remove",
    targets: LISTING,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "l'annonce ne respecte pas nos conditions générales d'utilisation", ar: "لا يحترم الإعلان شروط الاستخدام العامة" },
    explanation: { fr: "le manquement est précisé ci-dessous", ar: "الإخلال موضّح أدناه" },
    outcome: "founded",
    defaultSanction: "none",
    detailsRequired: true,
  },
  {
    id: "listing.restrict",
    label: "Visibilité restreinte (annonce masquée, à préciser)",
    action: "restrict_visibility",
    targets: LISTING,
    ground: { type: "terms", ref: RULES },
    facts: { fr: "l'annonce ne respecte pas nos règles de publication", ar: "لا يحترم الإعلان قواعد النشر" },
    explanation: {
      fr: "l'annonce reste masquée des recherches et de sa page publique ; le manquement est précisé ci-dessous",
      ar: "يبقى الإعلان مخفيًا من نتائج البحث ومن صفحته العامة؛ الإخلال موضّح أدناه",
    },
    outcome: "founded",
    defaultSanction: "none",
    detailsRequired: true,
  },
  {
    id: "listing.restore",
    label: "Rétablissement : signalement non fondé",
    action: "restore",
    targets: LISTING,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "après examen du signalement, l'annonce respecte nos règles", ar: "بعد فحص التبليغ، يحترم الإعلان قواعدنا" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  {
    id: "listing.no_action",
    label: "Aucune mesure : signalement non fondé",
    action: "no_action",
    targets: LISTING,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "après examen du signalement, aucune infraction n'a été constatée", ar: "بعد فحص التبليغ، لم تتم معاينة أي مخالفة" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  // ---- Messages -------------------------------------------------------------------------------
  {
    id: "message.remove.scam",
    label: "Message masqué : arnaque ou paiement hors plateforme",
    action: "remove",
    targets: MESSAGE,
    ground: { type: "terms", ref: "CGU, messagerie (arnaques)" },
    facts: {
      fr: "le message demande un paiement d'avance, un virement ou des coordonnées bancaires, ou renvoie vers un lien suspect",
      ar: "تطلب الرسالة أداءً مسبقًا أو تحويلًا أو بيانات بنكية، أو تحيل إلى رابط مشبوه",
    },
    explanation: { fr: "nos conditions générales interdisent les tentatives d'arnaque dans la messagerie", ar: "تمنع شروطنا العامة محاولات الاحتيال عبر المراسلة" },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "message.remove.harassment",
    label: "Message masqué : harcèlement ou insultes",
    action: "remove",
    targets: MESSAGE,
    ground: { type: "terms", ref: CONDUCT },
    facts: { fr: "le message contient des insultes, des pressions ou du harcèlement", ar: "تحتوي الرسالة على سب أو ضغط أو تحرش" },
    explanation: { fr: "nos conditions générales exigent des échanges courtois", ar: "تشترط شروطنا العامة تبادلًا لائقًا" },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "message.remove.hate",
    label: "Message masqué : discours haineux",
    action: "remove",
    targets: MESSAGE,
    ground: { type: "terms", ref: `${CONDUCT} (haine)` },
    facts: {
      fr: "le message vise une personne pour son origine, sa religion, son sexe ou une autre caractéristique",
      ar: "تستهدف الرسالة شخصًا بسبب أصله أو دينه أو جنسه أو صفة أخرى",
    },
    explanation: { fr: "nos conditions générales interdisent les propos haineux ou discriminatoires", ar: "تمنع شروطنا العامة خطاب الكراهية والتمييز" },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "message.remove.spam",
    label: "Message masqué : spam ou publicité",
    action: "remove",
    targets: MESSAGE,
    ground: { type: "terms", ref: CONDUCT },
    facts: { fr: "le message est un envoi en masse ou une publicité sans rapport avec l'annonce", ar: "الرسالة إرسال جماعي أو إشهار لا علاقة له بالإعلان" },
    explanation: { fr: "nos conditions générales réservent la messagerie aux échanges sur les annonces", ar: "تخصص شروطنا العامة المراسلة للتبادل بشأن الإعلانات" },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "message.remove.p0",
    label: "Message masqué P0 confirmé : contenu illicite grave (bannissement)",
    action: "remove",
    targets: MESSAGE,
    ground: { type: "illegal", ref: "Code pénal (contenu illicite grave)" },
    facts: {
      fr: "le message contient un contenu illicite grave (mise en danger de mineurs, terrorisme ou menace de violence)",
      ar: "تحتوي الرسالة على محتوى غير قانوني خطير (تعريض قاصرين للخطر أو إرهاب أو تهديد بالعنف)",
    },
    explanation: { fr: "ce contenu est interdit par la loi et par nos conditions générales", ar: "هذا المحتوى ممنوع بموجب القانون وبموجب شروطنا العامة" },
    outcome: "founded",
    defaultSanction: "ban",
    p0: true,
  },
  {
    id: "message.restore",
    label: "Message rétabli : signalement non fondé",
    action: "restore",
    targets: MESSAGE,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "après examen du signalement, le message respecte nos règles", ar: "بعد فحص التبليغ، تحترم الرسالة قواعدنا" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  {
    id: "message.no_action",
    label: "Aucune mesure sur le message",
    action: "no_action",
    targets: MESSAGE,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "après examen du signalement, aucune infraction n'a été constatée", ar: "بعد فحص التبليغ، لم تتم معاينة أي مخالفة" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  // ---- Reviews (vitrine-avis §3): a hidden review leaves the seller's average --------------------
  {
    id: "review.remove.personal_data",
    label: "Avis masqué : données personnelles ou sensibles",
    action: "remove",
    targets: REVIEW,
    ground: { type: "terms", ref: `${REVIEWS} (données personnelles)` },
    facts: {
      fr: "l'avis contient des données personnelles ou sensibles (numéro, adresse, santé, religion ou opinions d'une personne)",
      ar: "يحتوي التقييم على معطيات شخصية أو حساسة (رقم، عنوان، صحة، دين أو آراء شخص)",
    },
    explanation: {
      fr: "nos conditions générales interdisent de publier dans un avis des données personnelles ou sensibles",
      ar: "تمنع شروطنا العامة نشر معطيات شخصية أو حساسة في تقييم",
    },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "review.remove.abuse",
    label: "Avis masqué : insultes, haine ou dénigrement",
    action: "remove",
    targets: REVIEW,
    ground: { type: "terms", ref: `${REVIEWS} (respect)` },
    facts: {
      fr: "l'avis contient des insultes, des propos haineux ou des accusations sans rapport avec l'échange",
      ar: "يحتوي التقييم على سب أو خطاب كراهية أو اتهامات لا علاقة لها بالمعاملة",
    },
    explanation: {
      fr: "nos conditions générales exigent un avis courtois, qui décrit l'échange sans attaquer la personne",
      ar: "تشترط شروطنا العامة تقييمًا لائقًا يصف المعاملة دون التهجم على الشخص",
    },
    outcome: "founded",
    defaultSanction: "next",
  },
  {
    id: "review.remove.fake",
    label: "Avis masqué : faux avis ou hors sujet",
    action: "remove",
    targets: REVIEW,
    ground: { type: "terms", ref: `${REVIEWS} (authenticité)` },
    facts: {
      fr: "l'avis ne décrit pas l'échange réalisé avec ce membre (avis de complaisance, contrepartie, hors sujet)",
      ar: "لا يصف التقييم المعاملة التي تمت مع هذا العضو (تقييم مجاملة، مقابل، خارج الموضوع)",
    },
    explanation: {
      fr: "nos conditions générales n'acceptent que des avis sincères sur un échange réel",
      ar: "لا تقبل شروطنا العامة إلا تقييمات صادقة عن معاملة حقيقية",
    },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "review.remove.spam",
    label: "Avis masqué : publicité, lien ou coordonnées",
    action: "remove",
    targets: REVIEW,
    ground: { type: "terms", ref: `${REVIEWS} (publicité)` },
    facts: { fr: "l'avis contient de la publicité, un lien ou des coordonnées", ar: "يحتوي التقييم على إشهار أو رابط أو معلومات اتصال" },
    explanation: { fr: "nos conditions générales réservent les avis à la description de l'échange", ar: "تخصص شروطنا العامة التقييمات لوصف المعاملة" },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "review.remove.p0",
    label: "Avis masqué P0 confirmé : contenu illicite grave (bannissement)",
    action: "remove",
    targets: REVIEW,
    ground: { type: "illegal", ref: "Code pénal (contenu illicite grave)" },
    facts: {
      fr: "l'avis contient un contenu illicite grave (mise en danger de mineurs, terrorisme ou menace de violence)",
      ar: "يحتوي التقييم على محتوى غير قانوني خطير (تعريض قاصرين للخطر أو إرهاب أو تهديد بالعنف)",
    },
    explanation: { fr: "ce contenu est interdit par la loi et par nos conditions générales", ar: "هذا المحتوى ممنوع بموجب القانون وبموجب شروطنا العامة" },
    outcome: "founded",
    defaultSanction: "ban",
    p0: true,
  },
  {
    id: "review.restore",
    label: "Avis rétabli : signalement non fondé",
    action: "restore",
    targets: REVIEW,
    ground: { type: "terms", ref: REVIEWS },
    facts: { fr: "après examen du signalement, l'avis respecte nos règles", ar: "بعد فحص التبليغ، يحترم التقييم قواعدنا" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  {
    id: "review.no_action",
    label: "Aucune mesure : l'avis est publié",
    action: "no_action",
    targets: REVIEW,
    ground: { type: "terms", ref: REVIEWS },
    facts: { fr: "après examen, l'avis respecte nos règles et reste publié", ar: "بعد الفحص، يحترم التقييم قواعدنا ويبقى منشورًا" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  // ---- Accounts (sanctions ladder, D14) ---------------------------------------------------------
  {
    id: "user.warn",
    label: "Avertissement",
    action: "warn",
    targets: USER,
    ground: { type: "terms", ref: SANCTIONS },
    facts: { fr: "votre compte ne respecte pas nos conditions générales d'utilisation", ar: "حسابك لا يحترم شروط الاستخدام العامة" },
    explanation: {
      fr: "il s'agit d'un avertissement : aucune restriction n'est appliquée à votre compte, mais un nouveau manquement peut entraîner sa suspension",
      ar: "هذا إنذار: لا يُطبَّق أي تقييد على حسابك، لكن أي إخلال جديد قد يؤدي إلى توقيفه",
    },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "user.suspend.7",
    label: "Suspension du compte : 7 jours",
    action: "suspend_account",
    targets: USER,
    ground: { type: "terms", ref: SANCTIONS },
    facts: { fr: "manquements répétés à nos conditions générales d'utilisation", ar: "إخلال متكرر بشروط الاستخدام العامة" },
    explanation: {
      fr: "deuxième étape de nos sanctions graduées (avertissement, 7 jours, 30 jours, fermeture) : compte suspendu {days} jours, annonces en ligne mises en pause",
      ar: "المرحلة الثانية من عقوباتنا المتدرجة (إنذار، 7 أيام، 30 يومًا، إغلاق): توقيف الحساب لمدة {days} أيام وإيقاف الإعلانات المنشورة مؤقتًا",
    },
    outcome: "founded",
    defaultSanction: "none",
    durationDays: 7,
  },
  {
    id: "user.suspend.30",
    label: "Suspension du compte : 30 jours",
    action: "suspend_account",
    targets: USER,
    ground: { type: "terms", ref: SANCTIONS },
    facts: { fr: "nouveaux manquements à nos conditions générales après une première suspension", ar: "إخلال جديد بشروط الاستخدام العامة بعد توقيف أول" },
    explanation: {
      fr: "troisième étape de nos sanctions graduées (avertissement, 7 jours, 30 jours, fermeture) : compte suspendu {days} jours, annonces en ligne mises en pause",
      ar: "المرحلة الثالثة من عقوباتنا المتدرجة (إنذار، 7 أيام، 30 يومًا، إغلاق): توقيف الحساب لمدة {days} يومًا وإيقاف الإعلانات المنشورة مؤقتًا",
    },
    outcome: "founded",
    defaultSanction: "none",
    durationDays: 30,
  },
  {
    id: "user.ban",
    label: "Fermeture définitive du compte",
    action: "ban",
    targets: USER,
    ground: { type: "terms", ref: SANCTIONS },
    facts: { fr: "manquements graves ou répétés à nos conditions générales malgré les sanctions précédentes", ar: "إخلال خطير أو متكرر بشروطنا العامة رغم العقوبات السابقة" },
    explanation: {
      fr: "dernière étape de nos sanctions graduées : le compte est fermé et ses annonces sont retirées",
      ar: "المرحلة الأخيرة من عقوباتنا المتدرجة: يُغلق الحساب وتُسحب إعلاناته",
    },
    outcome: "founded",
    defaultSanction: "none",
  },
  {
    id: "user.ban.p0",
    label: "Fermeture immédiate : contenu illicite grave confirmé (P0)",
    action: "ban",
    targets: USER,
    ground: { type: "illegal", ref: "Code pénal (contenu illicite grave)" },
    facts: {
      fr: "publication d'un contenu illicite grave (mise en danger de mineurs, terrorisme ou menace de violence), confirmée par un modérateur",
      ar: "نشر محتوى غير قانوني خطير (تعريض قاصرين للخطر أو إرهاب أو تهديد بالعنف) أكّده مشرف",
    },
    explanation: {
      fr: "un contenu illicite grave confirmé entraîne la fermeture immédiate du compte et le retrait de ses annonces",
      ar: "يؤدي المحتوى غير القانوني الخطير المؤكَّد إلى الإغلاق الفوري للحساب وسحب إعلاناته",
    },
    outcome: "founded",
    defaultSanction: "none",
    p0: true,
  },
  {
    id: "user.restore",
    label: "Compte rétabli : signalement non fondé",
    action: "restore",
    targets: USER,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "après examen du signalement, le compte respecte nos règles", ar: "بعد فحص التبليغ، يحترم الحساب قواعدنا" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  {
    id: "user.no_action",
    label: "Aucune mesure sur le compte",
    action: "no_action",
    targets: USER,
    ground: { type: "terms", ref: "CGU" },
    facts: { fr: "après examen du signalement, aucune infraction n'a été constatée", ar: "بعد فحص التبليغ، لم تتم معاينة أي مخالفة" },
    explanation: NO_BREACH,
    outcome: "unfounded",
    defaultSanction: "none",
  },
  // ---- Server-side templates ------------------------------------------------------------------
  {
    id: "authority.remove",
    label: "Retrait sur injonction d'une autorité",
    action: "remove",
    targets: ["listing", "message", "review"],
    ground: { type: "illegal", ref: "Injonction d'une autorité" },
    facts: { fr: "une autorité compétente nous a ordonné de retirer ce contenu", ar: "أمرتنا سلطة مختصة بسحب هذا المحتوى" },
    explanation: { fr: "le retrait exécute cette injonction", ar: "يُنفِّذ السحبُ هذا الأمر" },
    outcome: "founded",
    defaultSanction: "none",
    internal: true,
  },
  {
    id: "appeal.reversed",
    label: "Décision annulée après réexamen",
    action: "restore",
    targets: ALL,
    ground: { type: "terms", ref: "DSA art. 20 (réexamen)" },
    facts: { fr: "après réexamen par un autre modérateur, la décision précédente est annulée", ar: "بعد إعادة الفحص من طرف مشرف آخر، أُلغي القرار السابق" },
    explanation: { fr: "les éléments du recours justifient l'annulation de la mesure", ar: "تبرّر عناصر الطعن إلغاء الإجراء" },
    outcome: "unfounded",
    defaultSanction: "none",
    internal: true,
  },
] as const satisfies readonly DecisionTemplate[];

export type DecisionTemplateId = (typeof DECISION_TEMPLATES)[number]["id"];
export const DECISION_TEMPLATE_IDS = DECISION_TEMPLATES.map((template) => template.id) as unknown as readonly [DecisionTemplateId, ...DecisionTemplateId[]];

const BY_ID = new Map<string, DecisionTemplate>(DECISION_TEMPLATES.map((template) => [template.id, template]));

export function decisionTemplate(id: string): DecisionTemplate | undefined {
  return BY_ID.get(id);
}

/** Templates the back office offers for a target type (internal ones excluded). */
export function templatesFor(target: DecisionTargetType): DecisionTemplate[] {
  return DECISION_TEMPLATES.filter((template: DecisionTemplate) => !template.internal && template.targets.includes(target));
}

/** The template of a sanction (ladder step) applied with a content decision. */
export function sanctionTemplateId(action: SanctionAction, options: { durationDays?: SuspensionDays; p0?: boolean } = {}): DecisionTemplateId {
  if (action === "warn") return "user.warn";
  if (action === "ban") return options.p0 ? "user.ban.p0" : "user.ban";
  return options.durationDays === 30 ? "user.suspend.30" : "user.suspend.7";
}

/** A template text with its placeholders filled. */
export function fillTemplateText(text: string, values: { days?: number }): string {
  return text.replace(/\{days\}/g, values.days !== undefined ? String(values.days) : "");
}
