import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

const COPY: Record<MailLocale, { subject: string; title: string; body: (phone: string) => string[]; button: string; notYou: string }> = {
  fr: {
    subject: "Ton numéro de téléphone est vérifié",
    title: "Numéro vérifié",
    body: (phone) => [
      `Ton numéro ${phone} est maintenant vérifié sur Aalan. Tes annonces affichent le badge « Téléphone vérifié » et les acheteurs peuvent te contacter en confiance.`,
    ],
    button: "Voir mes paramètres",
    notYou: "Si tu n'es pas à l'origine de cette vérification, change ton mot de passe sans attendre.",
  },
  ar: {
    subject: "تم التحقق من رقم هاتفك",
    title: "تم التحقق من الرقم",
    body: (phone) => [`تم الآن التحقق من رقمك ${phone} على Aalan. تعرض إعلاناتك شارة «هاتف موثّق» ويمكن للمشترين التواصل معك بثقة.`],
    button: "عرض إعداداتي",
    notYou: "إذا لم تكن أنت من قام بهذا التحقق، فغيّر كلمة المرور الخاصة بك فورًا.",
  },
};

export function phoneVerified(data: TemplateData["phoneVerified"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    // Isolate the number from the surrounding RTL text.
    paragraphs: copy.body(ctx.lang === "ar" ? `⁦${data.phone}⁩` : data.phone),
    action: { label: copy.button, url: pageUrl(ctx, "parametres") },
    closing: [copy.notYou],
  });
}
