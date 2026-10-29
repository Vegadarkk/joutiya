import type { TemplateData } from "../types";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

const COPY: Record<MailLocale, { subject: string; title: string; body: (at: string) => string[]; button: string; notYou: string }> = {
  fr: {
    subject: "Ton mot de passe a été modifié",
    title: "Mot de passe modifié",
    body: (at) => [`Le mot de passe de ton compte Aalan a été modifié le ${at}.`, "Si c'est bien toi, tout est en ordre : tu n'as rien à faire."],
    button: "Réinitialiser mon mot de passe",
    notYou: "Si tu n'es pas à l'origine de cette demande, réinitialise ton mot de passe sans attendre grâce au bouton ci-dessus, puis ignore cet e-mail.",
  },
  ar: {
    subject: "تم تغيير كلمة المرور الخاصة بك",
    title: "تم تغيير كلمة المرور",
    body: (at) => [`تم تغيير كلمة مرور حسابك على Aalan بتاريخ ${at}.`, "إذا كنت أنت من قام بذلك، فكل شيء على ما يرام ولا حاجة لأي إجراء."],
    button: "إعادة تعيين كلمة المرور",
    notYou: "إذا لم تكن أنت من قام بهذا الطلب، فأعد تعيين كلمة المرور فورًا عبر الزر أعلاه، ثم تجاهل هذا البريد الإلكتروني.",
  },
};

export function passwordChanged(data: TemplateData["passwordChanged"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(formatDate(data.at, ctx.locale)),
    action: { label: copy.button, url: pageUrl(ctx, "mot-de-passe-oublie") },
    closing: [copy.notYou],
  });
}
