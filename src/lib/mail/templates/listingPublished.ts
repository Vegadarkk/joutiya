import type { TemplateData } from "../types";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// The listing is online (design D8, D16): link to the public page, expiry date, link to "Mes annonces".

const COPY: Record<MailLocale, { subject: (title: string) => string; title: string; body: (title: string, expires: string) => string[]; button: string; manage: string; closing: string }> = {
  fr: {
    subject: (title) => `Votre annonce « ${title} » est en ligne`,
    title: "Annonce publiée",
    body: (title, expires) => [
      `Votre annonce « ${title} » est maintenant visible sur Aalan. Les acheteurs peuvent vous écrire depuis la messagerie.`,
      `Elle reste en ligne jusqu'au ${expires}. Vous pourrez la renouveler gratuitement dans les derniers jours, ou la marquer vendue dès qu'elle trouve preneur.`,
    ],
    button: "Voir mon annonce",
    manage: "Gérer mes annonces :",
    closing: "Aalan ne vous demandera jamais de paiement et n'envoie aucun lien de paiement.",
  },
  ar: {
    subject: (title) => `إعلانك «${title}» صار متاحًا`,
    title: "تم نشر الإعلان",
    body: (title, expires) => [
      `إعلانك «${title}» ظاهر الآن على Aalan. يمكن للمشترين مراسلتك عبر الرسائل.`,
      `يبقى الإعلان منشورًا حتى ${expires}. يمكنك تجديده مجانًا في الأيام الأخيرة، أو تعليمه كمُباع بمجرد بيعه.`,
    ],
    button: "عرض إعلاني",
    manage: "إدارة إعلاناتي:",
    closing: "لن تطلب منك Aalan أي دفع أبدًا ولا ترسل روابط دفع.",
  },
};

export function listingPublished(data: TemplateData["listingPublished"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.title),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data.title, formatDate(data.expiresAt, ctx.locale)),
    action: { label: copy.button, url: data.url },
    links: [{ label: copy.manage, url: pageUrl(ctx, "mes-annonces") }],
    closing: [copy.closing],
  });
}
