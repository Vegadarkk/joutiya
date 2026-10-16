import type { ModerationStatement } from "../types";
import type { MailLocale } from "./layout";

// Art. 17 DSA statement of reasons (design D8), shared by the hold and rejection mails: the
// measure, the facts (moderation flags translated, or a moderator's own words), the ground, the
// automated nature of the decision and the redress channel (reply to the DSA contact address).

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
  },
};

const COPY: Record<MailLocale, { measure: Record<ModerationStatement["measure"], string>; facts: string; noFacts: string; ground: string; automated: string; redress: (email: string) => string }> = {
  fr: {
    measure: { hold: "Mesure : publication suspendue dans l'attente d'une vérification humaine.", reject: "Mesure : annonce refusée, elle n'est pas publiée." },
    facts: "Faits constatés : ",
    noFacts: "Faits constatés : signaux de risque relevés par le contrôle automatique.",
    ground: "Fondement : ",
    automated: "Cette mesure a été prise par un traitement automatisé, sans intervention humaine à ce stade.",
    redress: (email) => `Pour la contester, répondez à cet e-mail ou écrivez à ${email} : un modérateur réexaminera votre annonce.`,
  },
  ar: {
    measure: { hold: "الإجراء: تعليق النشر في انتظار مراجعة بشرية.", reject: "الإجراء: رُفض الإعلان ولم يُنشر." },
    facts: "الوقائع المسجّلة: ",
    noFacts: "الوقائع المسجّلة: مؤشرات خطر رصدها الفحص الآلي.",
    ground: "الأساس: ",
    automated: "اتُّخذ هذا الإجراء بمعالجة آلية دون تدخل بشري في هذه المرحلة.",
    redress: (email) => `للاعتراض عليه، أجب على هذا البريد أو اكتب إلى ${email}: سيعيد مشرف فحص إعلانك.`,
  },
};

/** The statement as mail paragraphs, in the recipient's language. */
export function statementParagraphs(statement: ModerationStatement, lang: MailLocale): string[] {
  const copy = COPY[lang];
  const facts = statement.facts.map((fact) => FLAGS[lang][fact] ?? fact);
  return [
    copy.measure[statement.measure],
    facts.length > 0 ? `${copy.facts}${facts.join(" ; ")}.` : copy.noFacts,
    `${copy.ground}${statement.ground}.`,
    copy.automated,
    copy.redress(statement.redress),
  ];
}
