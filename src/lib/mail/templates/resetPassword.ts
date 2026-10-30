import type { TemplateData } from "../types";
import { GREETING, NOT_YOU, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

const COPY: Record<MailLocale, { subject: string; title: string; body: string[]; button: string; expired: string }> = {
  fr: {
    subject: "Réinitialise ton mot de passe",
    title: "Réinitialisation du mot de passe",
    body: ["Tu as demandé à réinitialiser le mot de passe de ton compte Aalan. Clique sur le bouton ci-dessous pour en choisir un nouveau."],
    button: "Choisir un nouveau mot de passe",
    expired: "Si le lien a expiré, refais une demande depuis la page « Mot de passe oublié ».",
  },
  ar: {
    subject: "أعد تعيين كلمة المرور",
    title: "إعادة تعيين كلمة المرور",
    body: ["لقد طلبت إعادة تعيين كلمة مرور حسابك على Aalan. اضغط على الزر أدناه لاختيار كلمة مرور جديدة."],
    button: "اختيار كلمة مرور جديدة",
    expired: "إذا انتهت صلاحية الرابط، فأعد الطلب من صفحة «نسيت كلمة المرور».",
  },
};

export function resetPassword(data: TemplateData["resetPassword"], ctx: TemplateContext): BuiltMail {
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
