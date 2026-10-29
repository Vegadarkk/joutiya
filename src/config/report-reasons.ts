// Report reasons (architecture §7 "Signalement : parcours", design D10-D12). The reason fixes the
// priority, hence the target delay (SLA) and whether a strong signal may hide the content at once
// (P0 only). Client-safe: the report dialog lists the reasons allowed for its target type.

export const REPORT_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];

export const REPORT_TARGET_TYPES = ["listing", "user", "message", "pro", "review"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Target delay of a decision, from the report's creation (AF §7: P0 < 1 h, P1 24 h, P2 72 h, P3 7 days). */
export const SLA_MS: Record<ReportPriority, number> = { P0: HOUR, P1: DAY, P2: 3 * DAY, P3: 7 * DAY };

export interface ReportReason {
  id: string;
  priority: ReportPriority;
  targets: readonly ReportTargetType[];
  label: { fr: string; ar: string };
  /** One line under the label in the dialog. */
  hint: { fr: string; ar: string };
  /** Default legal ground of a decision taken on this reason (art. 17(3)(d) DSA). */
  ground: { type: "illegal" | "terms"; ref: string };
}

const ALL: readonly ReportTargetType[] = ["listing", "user", "message", "pro", "review"];
const PEOPLE: readonly ReportTargetType[] = ["user", "message", "pro", "review"];
const CONTENT: readonly ReportTargetType[] = ["listing", "pro"];

export const REPORT_REASONS = [
  // P0: alert at once, hidden only on a strong signal (D11).
  {
    id: "minors",
    priority: "P0",
    targets: ALL,
    label: { fr: "Mise en danger ou exploitation de mineurs", ar: "تعريض قاصرين للخطر أو استغلالهم" },
    hint: { fr: "Contenu sexuel impliquant un mineur, exploitation ou mise en danger d'un enfant.", ar: "محتوى جنسي يتعلق بقاصر، أو استغلال طفل أو تعريضه للخطر." },
    ground: { type: "illegal", ref: "C. pén. art. 227-23" },
  },
  {
    id: "terrorism",
    priority: "P0",
    targets: ALL,
    label: { fr: "Terrorisme ou apologie du terrorisme", ar: "إرهاب أو إشادة بالإرهاب" },
    hint: { fr: "Contenu terroriste, appel ou apologie.", ar: "محتوى إرهابي أو دعوة إليه أو إشادة به." },
    ground: { type: "illegal", ref: "Règlement (UE) 2021/784" },
  },
  {
    id: "threat",
    priority: "P0",
    targets: ALL,
    label: { fr: "Menace ou incitation à la violence", ar: "تهديد أو تحريض على العنف" },
    hint: { fr: "Menace contre une personne, appel à la violence.", ar: "تهديد شخص أو الدعوة إلى العنف." },
    ground: { type: "illegal", ref: "C. pén. art. 222-17" },
  },
  // P1: 24 hours.
  {
    id: "scam",
    priority: "P1",
    targets: ALL,
    label: { fr: "Arnaque ou tentative d'escroquerie", ar: "احتيال أو محاولة نصب" },
    hint: { fr: "Demande d'acompte, faux paiement, objet inexistant, lien suspect.", ar: "طلب عربون، أداء مزيف، سلعة غير موجودة، رابط مشبوه." },
    ground: { type: "illegal", ref: "C. pén. art. 313-1" },
  },
  {
    // « Payer chez le vendeur » (2026-10-28): a moderator may cut the shop's button, listings kept.
    id: "payment_link",
    priority: "P1",
    targets: ["listing", "user", "pro"],
    label: { fr: "Lien de paiement suspect", ar: "رابط دفع مشبوه" },
    hint: { fr: "Le bouton « Payer chez le vendeur » mène à une page douteuse ou à un autre vendeur.", ar: "زر «الدفع لدى البائع» يقود إلى صفحة مريبة أو إلى بائع آخر." },
    ground: { type: "illegal", ref: "C. pén. art. 313-1" },
  },
  {
    id: "illegal_item",
    priority: "P1",
    targets: CONTENT,
    label: { fr: "Objet ou service illégal ou interdit", ar: "سلعة أو خدمة غير قانونية أو ممنوعة" },
    hint: { fr: "Armes, drogues, médicaments, animaux protégés, objets volés…", ar: "أسلحة، مخدرات، أدوية، حيوانات محمية، أشياء مسروقة…" },
    ground: { type: "terms", ref: "Objets interdits" },
  },
  {
    id: "impersonation",
    priority: "P1",
    targets: ["listing", "user", "pro"],
    label: { fr: "Usurpation d'identité", ar: "انتحال هوية" },
    hint: { fr: "Le compte se fait passer pour une autre personne ou entreprise.", ar: "الحساب ينتحل صفة شخص أو مقاولة أخرى." },
    ground: { type: "illegal", ref: "C. pén. art. 226-4-1" },
  },
  {
    id: "personal_data",
    priority: "P1",
    targets: ALL,
    label: { fr: "Mes données personnelles publiées sans mon accord", ar: "نشر معطياتي الشخصية دون موافقتي" },
    hint: { fr: "Votre nom, votre numéro, votre photo ou une donnée sensible vous concernant.", ar: "اسمك أو رقمك أو صورتك أو معطى حساس يخصك." },
    ground: { type: "illegal", ref: "RGPD art. 6 et 9" },
  },
  {
    id: "hate",
    priority: "P1",
    targets: ALL,
    label: { fr: "Discours haineux ou discriminatoire", ar: "خطاب كراهية أو تمييز" },
    hint: { fr: "Propos visant une personne pour son origine, sa religion, son sexe…", ar: "كلام يستهدف شخصا بسبب أصله أو دينه أو جنسه…" },
    ground: { type: "illegal", ref: "Loi 29/07/1881 art. 24" },
  },
  {
    id: "sexual_content",
    priority: "P1",
    targets: ALL,
    label: { fr: "Contenu sexuel ou nudité", ar: "محتوى جنسي أو عري" },
    hint: { fr: "Photos ou textes à caractère sexuel.", ar: "صور أو نصوص ذات طابع جنسي." },
    ground: { type: "terms", ref: "CGU, contenus interdits" },
  },
  // P2: 72 hours.
  {
    id: "counterfeit",
    priority: "P2",
    targets: CONTENT,
    label: { fr: "Contrefaçon", ar: "تقليد" },
    hint: { fr: "Copie d'une marque présentée comme authentique.", ar: "نسخة من علامة تجارية تقدم على أنها أصلية." },
    ground: { type: "illegal", ref: "CPI art. L716-9" },
  },
  {
    id: "misleading",
    priority: "P2",
    targets: CONTENT,
    label: { fr: "Annonce trompeuse", ar: "إعلان مضلل" },
    hint: { fr: "Prix, état ou photos qui ne correspondent pas à l'objet.", ar: "ثمن أو حالة أو صور لا تطابق السلعة." },
    ground: { type: "terms", ref: "CGU, règles de publication" },
  },
  {
    id: "harassment",
    priority: "P2",
    targets: PEOPLE,
    label: { fr: "Harcèlement ou insultes", ar: "تحرش أو سب" },
    hint: { fr: "Messages répétés, insultes, pression.", ar: "رسائل متكررة، سب، ضغط." },
    ground: { type: "terms", ref: "CGU, comportement" },
  },
  {
    id: "fake_review",
    priority: "P2",
    targets: ["review"],
    label: { fr: "Avis faux ou sans rapport avec l'échange", ar: "تقييم كاذب أو لا علاقة له بالمعاملة" },
    hint: { fr: "L'avis ne décrit pas un vrai échange, ou parle d'autre chose que la transaction.", ar: "التقييم لا يصف معاملة حقيقية، أو يتحدث عن شيء غير المعاملة." },
    ground: { type: "terms", ref: "CGU, avis utilisateurs" },
  },
  {
    // Social links of a shop (2026-10-29): a moderator may hide them all, storefront and listings kept.
    id: "social_link",
    priority: "P2",
    targets: ["user", "pro"],
    label: { fr: "Lien de réseau social suspect", ar: "رابط شبكة اجتماعية مشبوه" },
    hint: { fr: "Un lien de la vitrine mène au compte d'un autre vendeur, à une page douteuse ou à un contenu interdit.", ar: "رابط في الواجهة يقود إلى حساب بائع آخر أو إلى صفحة مريبة أو محتوى ممنوع." },
    ground: { type: "terms", ref: "CGU, vitrines professionnelles" },
  },
  // P3: 7 days.
  {
    id: "spam",
    priority: "P3",
    targets: ALL,
    label: { fr: "Spam ou publicité", ar: "رسائل مزعجة أو إشهار" },
    hint: { fr: "Messages en masse, publicité hors sujet.", ar: "رسائل جماعية أو إشهار خارج الموضوع." },
    ground: { type: "terms", ref: "CGU, règles de publication" },
  },
  {
    id: "duplicate",
    priority: "P3",
    targets: CONTENT,
    label: { fr: "Annonce en double", ar: "إعلان مكرر" },
    hint: { fr: "La même annonce publiée plusieurs fois.", ar: "نفس الإعلان منشور عدة مرات." },
    ground: { type: "terms", ref: "CGU, règles de publication" },
  },
  {
    id: "wrong_category",
    priority: "P3",
    targets: CONTENT,
    label: { fr: "Mauvaise catégorie", ar: "فئة خاطئة" },
    hint: { fr: "L'annonce n'est pas dans la bonne rubrique.", ar: "الإعلان ليس في الفئة المناسبة." },
    ground: { type: "terms", ref: "CGU, règles de publication" },
  },
  {
    id: "other",
    priority: "P3",
    targets: ALL,
    label: { fr: "Autre problème", ar: "مشكل آخر" },
    hint: { fr: "Expliquez ce qui ne va pas.", ar: "اشرح المشكل." },
    ground: { type: "terms", ref: "CGU" },
  },
] as const satisfies readonly ReportReason[];

export type ReportReasonId = (typeof REPORT_REASONS)[number]["id"];
export const REPORT_REASON_IDS = REPORT_REASONS.map((reason) => reason.id) as unknown as readonly [ReportReasonId, ...ReportReasonId[]];

const BY_ID = new Map<string, ReportReason>(REPORT_REASONS.map((reason) => [reason.id, reason]));

export function reportReason(id: string): ReportReason | undefined {
  return BY_ID.get(id);
}

/** The reasons the dialog offers for a target type, in priority order. */
export function reasonsFor(target: ReportTargetType): ReportReason[] {
  return REPORT_REASONS.filter((reason) => (reason.targets as readonly ReportTargetType[]).includes(target));
}

export function slaDueAt(priority: ReportPriority, createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_MS[priority]);
}
