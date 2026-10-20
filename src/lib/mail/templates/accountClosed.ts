import type { TemplateData } from "../types";
import { formatDay, GREETING, mailContact, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// The account is closed (phase 5 D26, lot L7): what stops at once, what is kept and until when
// (AF §7: account data 1 year, civil identity 5 years, reports and decisions 5 years), and whom to
// write to when the closure was not asked by the owner of the address. No link to sign in: the
// account no longer opens.

const COPY: Record<MailLocale, { subject: string; title: string; body: (closed: string, purge: string) => string[]; button: string; notYou: (contact: string) => string }> = {
  fr: {
    subject: "Votre compte Joutiya est fermé",
    title: "Compte fermé",
    body: (closed, purge) => [
      `Votre compte Joutiya a été fermé le ${closed}, à votre demande. Vous ne pouvez plus vous y connecter, vos annonces ne sont plus en ligne, et vos favoris et recherches enregistrées ont été supprimés.`,
      "Les personnes avec qui vous avez échangé peuvent encore relire vos conversations, sans pouvoir vous écrire. Elles sont supprimées 12 mois après le dernier message.",
      `Comme la loi nous y oblige, nous conservons vos données de compte (adresse e-mail, téléphone, nom affiché) jusqu'au ${purge}, puis nous les supprimons. Votre nom légal, s'il nous a été communiqué, est conservé cinq ans ; les signalements et les décisions de modération qui vous concernent, cinq ans également.`,
    ],
    button: "Notre politique de confidentialité",
    notYou: (contact) => `Si vous n'avez pas demandé cette fermeture, écrivez-nous sans attendre à ${contact}.`,
  },
  ar: {
    subject: "تم إغلاق حسابك على Joutiya",
    title: "تم إغلاق الحساب",
    body: (closed, purge) => [
      `تم إغلاق حسابك على Joutiya بتاريخ ${closed} بناءً على طلبك. لم يعد بإمكانك تسجيل الدخول إليه، ولم تعد إعلاناتك منشورة، وتم حذف مفضلاتك وعمليات البحث المحفوظة.`,
      "يمكن للأشخاص الذين تبادلت معهم الرسائل إعادة قراءة محادثاتكم دون أن يتمكنوا من مراسلتك. تُحذف هذه المحادثات بعد 12 شهرًا من آخر رسالة.",
      `وفقًا لما يفرضه القانون، نحتفظ ببيانات حسابك (البريد الإلكتروني والهاتف والاسم المعروض) حتى ${purge}، ثم نحذفها. ويُحتفظ باسمك القانوني، إن كنت قد قدمته، لمدة خمس سنوات، وكذلك البلاغات وقرارات الإشراف المتعلقة بك.`,
    ],
    button: "سياسة الخصوصية",
    notYou: (contact) => `إذا لم تطلب إغلاق هذا الحساب، فراسلنا فورًا على ${contact}.`,
  },
};

export function accountClosed(data: TemplateData["accountClosed"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  // The address is Latin script: isolated in the Arabic copy so the full stop stays after it.
  const isolate = (value: string) => (ctx.lang === "ar" ? `\u2066${value}\u2069` : value);
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(formatDay(data.closedAt, ctx.locale), formatDay(data.purgeAt, ctx.locale)),
    action: { label: copy.button, url: pageUrl(ctx, "legal/confidentialite") },
    closing: [copy.notYou(isolate(mailContact()))],
  });
}
