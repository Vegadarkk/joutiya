import { DEFAULT_LEGAL } from "@/config/legal";
import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Security mail of the phone transfer (src/lib/phone-verify/inbound.ts): the number was just
// verified from the phone itself on another account, so it left this one. The contact address is
// the one of the legal notice, never hardcoded.

const COPY: Record<MailLocale, { subject: string; title: string; body: (phone: string) => string[]; button: string; notYou: (contact: string) => string }> = {
  fr: {
    subject: "Ton numéro de téléphone a été retiré de ton compte",
    title: "Numéro retiré",
    body: (phone) => [
      `Le numéro ${phone} vient d'être vérifié depuis ce téléphone sur un autre compte Joutiya. Il a donc été retiré de ton compte, et tes annonces n'affichent plus le badge « Téléphone vérifié ».`,
      "Si c'est bien toi (un second compte, par exemple), tout est en ordre. Tu peux vérifier un autre numéro à tout moment.",
    ],
    button: "Vérifier un numéro",
    notYou: (contact) => `Si ce n'est pas toi, écris-nous sans attendre à ${contact} depuis cette adresse e-mail : nous vérifierons avec toi.`,
  },
  ar: {
    subject: "تمت إزالة رقم هاتفك من حسابك",
    title: "تمت إزالة الرقم",
    body: (phone) => [
      `تم للتو التحقق من الرقم ${phone} من هذا الهاتف على حساب Joutiya آخر. لذلك أُزيل من حسابك، ولم تعد إعلاناتك تعرض شارة «هاتف موثّق».`,
      "إذا كنت أنت من قام بذلك (حساب ثانٍ مثلًا)، فكل شيء على ما يرام. يمكنك التحقق من رقم آخر في أي وقت.",
    ],
    button: "التحقق من رقم",
    notYou: (contact) => `إذا لم تكن أنت، فراسلنا فورًا على ${contact} من عنوان بريدك الإلكتروني هذا: سنتحقق من الأمر معك.`,
  },
};

export function phoneRemoved(data: TemplateData["phoneRemoved"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  // Isolate the number and the address from the surrounding RTL text.
  const isolate = (value: string) => (ctx.lang === "ar" ? `⁦${value}⁩` : value);
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(isolate(data.phone)),
    action: { label: copy.button, url: pageUrl(ctx, "verifications") },
    closing: [copy.notYou(isolate(DEFAULT_LEGAL.email))],
  });
}
