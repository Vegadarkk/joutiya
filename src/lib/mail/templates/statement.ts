import { reasonFactText } from "@/lib/moderation/decisions";
import type { ModerationStatement } from "../types";
import type { MailLocale } from "./layout";

// Art. 17 DSA statement of reasons (design D8), shared by the hold and rejection mails: the
// measure, the facts (moderation flags or reject reasons translated, or a moderator's own words),
// the ground, whether the decision was automated, and the redress channel (the DSA contact
// address, until the appeal form of phase 5).

const FLAGS: Record<MailLocale, Record<string, string>> = {
  fr: {
    prohibited_kw: "mention d'un objet ou d'un service interdit sur Joutiya",
    prohibited_soft: "vocabulaire proche d'un objet ou d'un service interdit",
    sensitive_text: "données personnelles sensibles dans le texte (santé, religion, opinions, origine, vie privée)",
    third_party_phone: "coordonnées d'un tiers dans le texte",
    face: "visage identifiable sur une photo",
    nsfw_review: "photo à vérifier (contenu potentiellement inapproprié)",
    price_outlier: "prix très éloigné des prix habituels de la catégorie",
    dup_text: "texte identique à une autre de vos annonces",
    dup_photo: "photo identique à une autre de vos annonces",
    new_account: "compte créé récemment",
    volume: "nombre élevé d'annonces déposées en 24 heures",
    restricted_category: "catégorie réservée aux personnes majeures : chaque annonce est vérifiée par un modérateur avant sa mise en ligne",
    credit_ad: "mensualité de crédit annoncée sans le taux effectif global (TEG) ni les mentions obligatoires de la loi 31-08",
    rental_review: "location de véhicule à vérifier : location avec chauffeur, pièce d'identité ou chèque en blanc demandé en garantie, ou véhicule au-delà de l'âge limite des flottes de location",
  },
  ar: {
    prohibited_kw: "ذكر غرض أو خدمة ممنوعة على Joutiya",
    prohibited_soft: "مفردات قريبة من غرض أو خدمة ممنوعة",
    sensitive_text: "بيانات شخصية حساسة في النص (الصحة، الدين، الآراء، الأصل، الحياة الخاصة)",
    third_party_phone: "بيانات اتصال لشخص آخر في النص",
    face: "وجه يمكن تمييزه في صورة",
    nsfw_review: "صورة تحتاج إلى مراجعة (محتوى قد يكون غير مناسب)",
    price_outlier: "سعر بعيد جدًا عن الأسعار المعتادة في هذه الفئة",
    dup_text: "نص مطابق لإعلان آخر من إعلاناتك",
    dup_photo: "صورة مطابقة لإعلان آخر من إعلاناتك",
    new_account: "حساب أُنشئ مؤخرًا",
    volume: "عدد كبير من الإعلانات المودعة خلال 24 ساعة",
    restricted_category: "فئة مخصصة للبالغين: يراجع مشرف كل إعلان قبل نشره",
    credit_ad: "قسط قرض معلن دون السعر الفعلي الإجمالي ولا البيانات الإلزامية للقانون 31.08",
    rental_review: "كراء سيارة يحتاج إلى مراجعة: كراء مع سائق، أو طلب وثيقة هوية أو شيك على بياض كضمان، أو سيارة تجاوزت السن المسموح بها لأساطيل الكراء",
  },
};

interface StatementCopy {
  measure: Record<ModerationStatement["measure"], string>;
  facts: string;
  noFacts: string;
  ground: string;
  automated: string;
  human: string;
  redress: (email: string, ref: string | undefined, human: boolean) => string;
}

const COPY: Record<MailLocale, StatementCopy> = {
  fr: {
    measure: { hold: "Mesure : publication suspendue dans l'attente d'une vérification humaine.", reject: "Mesure : annonce refusée, elle n'est pas publiée." },
    facts: "Faits constatés : ",
    noFacts: "Faits constatés : signaux de risque relevés par le contrôle automatique.",
    ground: "Fondement : ",
    automated: "Cette mesure a été prise par un traitement automatisé, sans intervention humaine à ce stade.",
    human: "Cette décision a été prise par un modérateur de Joutiya, après examen de l'annonce.",
    redress: (email, ref, human) =>
      `Pour la contester, écrivez à ${email}${ref ? ` en indiquant la référence ${ref}` : ""} : ${human ? "une autre personne" : "un modérateur"} réexaminera votre annonce.`,
  },
  ar: {
    measure: { hold: "الإجراء: تعليق النشر في انتظار مراجعة بشرية.", reject: "الإجراء: رُفض الإعلان ولم يُنشر." },
    facts: "الوقائع المسجّلة: ",
    noFacts: "الوقائع المسجّلة: مؤشرات خطر رصدها الفحص الآلي.",
    ground: "الأساس: ",
    automated: "اتُّخذ هذا الإجراء بمعالجة آلية دون تدخل بشري في هذه المرحلة.",
    human: "اتخذ هذا القرار مشرف لدى Joutiya بعد فحص الإعلان.",
    redress: (email, ref, human) => `للاعتراض عليه، اكتب إلى ${email}${ref ? ` مع ذكر المرجع ${ref}` : ""}: ${human ? "سيعيد شخص آخر" : "سيعيد مشرف"} فحص إعلانك.`,
  },
};

/** The statement as mail paragraphs, in the recipient's language; `ref` (listing id) is quoted in the redress line. */
export function statementParagraphs(statement: ModerationStatement, lang: MailLocale, ref?: string): string[] {
  const copy = COPY[lang];
  // A moderator's sentence may end with its own full stop: the list adds one.
  const facts = statement.facts.map((fact) => FLAGS[lang][fact] ?? reasonFactText(fact, lang) ?? fact.replace(/[.\s]+$/, ""));
  return [
    copy.measure[statement.measure],
    facts.length > 0 ? `${copy.facts}${facts.join(" ; ")}.` : copy.noFacts,
    `${copy.ground}${statement.ground}.`,
    statement.automated ? copy.automated : copy.human,
    copy.redress(statement.redress, ref, !statement.automated),
  ];
}
