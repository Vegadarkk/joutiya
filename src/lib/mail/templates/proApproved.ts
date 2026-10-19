import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Pro application validated by a moderator (phase 7 design §4). The claims changed, so every
// session of the account was revoked: the mail says to sign in again. With the launch offer
// (design D3) the Essentiel quotas are free until sales open, with `noticeDays` of notice.

interface Copy {
  subject: (shop: string) => string;
  title: string;
  body: (shop: string) => string[];
  offer: (days: number) => string;
  noPlan: string;
  button: string;
  closing: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (shop) => `Votre compte Pro « ${shop} » est validé`,
    title: "Compte Pro validé",
    body: (shop) => [`Nous avons vérifié les informations et les pièces de « ${shop} » : votre compte Pro est validé.`, "Reconnectez-vous pour accéder à votre espace Pro et publier en tant que professionnel."],
    offer: (days) => `L'offre Essentiel vous est offerte jusqu'à l'ouverture des ventes : vous serez prévenu ${days} jours avant tout paiement.`,
    noPlan: "Choisissez une offre depuis votre espace Pro pour publier vos annonces en tant que professionnel.",
    button: "Ouvrir mon espace Pro",
    closing: "Joutiya ne vous demandera jamais de paiement par message et n'envoie aucun lien de paiement par e-mail.",
  },
  ar: {
    subject: (shop) => `تم اعتماد حسابك المهني «${shop}»`,
    title: "تم اعتماد الحساب المهني",
    body: (shop) => [`راجعنا معلومات ووثائق «${shop}»، وتم اعتماد حسابك المهني.`, "أعد تسجيل الدخول للوصول إلى فضائك المهني والنشر بصفتك مهنيًا."],
    offer: (days) => `باقة Essentiel مجانية لك إلى حين فتح المبيعات، وسنخبرك قبل ${days} يومًا من أي دفع.`,
    noPlan: "اختر باقة من فضائك المهني لنشر إعلاناتك بصفتك مهنيًا.",
    button: "فتح فضائي المهني",
    closing: "لن تطلب منك Joutiya أي دفع عبر الرسائل ولا ترسل روابط دفع عبر البريد الإلكتروني.",
  },
};

export function proApproved(data: TemplateData["proApproved"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.shopName),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [...copy.body(data.shopName), data.launchOffer ? copy.offer(data.noticeDays) : copy.noPlan],
    action: { label: copy.button, url: pageUrl(ctx, "pro") },
    closing: [copy.closing],
  });
}
