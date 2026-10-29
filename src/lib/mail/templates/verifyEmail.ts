import type { TemplateData } from "../types";
import { GREETING, NOT_YOU, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

const COPY: Record<MailLocale, { subject: string; title: string; body: string[]; button: string; expired: string }> = {
  fr: {
    subject: "Confirme ton adresse e-mail",
    title: "Bienvenue sur Aalan",
    body: ["Il ne reste qu'une étape : confirme ton adresse e-mail pour activer ton compte et commencer à vendre ou acheter près de chez toi."],
    button: "Confirmer mon adresse",
    expired: "Si le lien a expiré, demande un nouvel e-mail depuis la page de connexion.",
  },
  ar: {
    subject: "أكّد عنوان بريدك الإلكتروني",
    title: "مرحبًا بك في Aalan",
    body: ["لم تتبقَّ سوى خطوة واحدة: أكّد عنوان بريدك الإلكتروني لتفعيل حسابك والبدء في البيع أو الشراء بالقرب منك."],
    button: "تأكيد عنواني",
    expired: "إذا انتهت صلاحية الرابط، فاطلب بريدًا جديدًا من صفحة تسجيل الدخول.",
  },
};

export function verifyEmail(data: TemplateData["verifyEmail"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body,
    action: { label: copy.button, url: data.actionUrl },
    closing: [copy.expired, NOT_YOU[ctx.lang]],
  });
}
