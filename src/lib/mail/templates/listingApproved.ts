import type { TemplateData } from "../types";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// A moderator approved a held listing (design D9): it is online now, until its expiry date.

const COPY: Record<MailLocale, { subject: (title: string) => string; title: string; body: (title: string, expires: string) => string[]; button: string; manage: string; closing: string }> = {
  fr: {
    subject: (title) => `Votre annonce « ${title} » a été vérifiée et publiée`,
    title: "Annonce vérifiée et publiée",
    body: (title, expires) => [
      `Un modérateur a vérifié votre annonce « ${title} » : elle est maintenant visible sur Joutiya. Les acheteurs peuvent vous écrire depuis la messagerie.`,
      `Elle reste en ligne jusqu'au ${expires}. Vous pourrez la renouveler gratuitement dans les derniers jours, ou la marquer vendue dès qu'elle trouve preneur.`,
    ],
    button: "Voir mon annonce",
    manage: "Gérer mes annonces :",
    closing: "Joutiya ne vous demandera jamais de paiement et n'envoie aucun lien de paiement.",
  },
  ar: {
    subject: (title) => `تمت مراجعة إعلانك «${title}» ونشره`,
    title: "تمت مراجعة الإعلان ونشره",
    body: (title, expires) => [
      `راجع أحد المشرفين إعلانك «${title}»، وهو ظاهر الآن على Joutiya. يمكن للمشترين مراسلتك عبر الرسائل.`,
      `يبقى الإعلان منشورًا حتى ${expires}. يمكنك تجديده مجانًا في الأيام الأخيرة، أو تعليمه كمُباع بمجرد بيعه.`,
    ],
    button: "عرض إعلاني",
    manage: "إدارة إعلاناتي:",
    closing: "لن تطلب منك Joutiya أي دفع أبدًا ولا ترسل روابط دفع.",
  },
};

export function listingApproved(data: TemplateData["listingApproved"], ctx: TemplateContext): BuiltMail {
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
