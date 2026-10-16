import type { TemplateData } from "../types";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Expiry reminder (design D16, bulk priority): the date, how to renew for free, or mark it sold.

const COPY: Record<MailLocale, { subject: (title: string) => string; title: string; body: (title: string, expires: string) => string[]; button: string; view: string; closing: string }> = {
  fr: {
    subject: (title) => `Votre annonce « ${title} » expire bientôt`,
    title: "Votre annonce expire bientôt",
    body: (title, expires) => [
      `Votre annonce « ${title} » ne sera plus visible à partir du ${expires}.`,
      "Si le bien est toujours disponible, renouvelez-la gratuitement depuis « Mes annonces » : elle repart pour une nouvelle période et remonte en tête des résultats. S'il est déjà vendu, marquez-la vendue.",
    ],
    button: "Renouveler mon annonce",
    view: "Voir l'annonce :",
    closing: "Vous recevez cet e-mail parce que votre annonce arrive au terme de sa durée de publication.",
  },
  ar: {
    subject: (title) => `ينتهي إعلانك «${title}» قريبًا`,
    title: "ينتهي إعلانك قريبًا",
    body: (title, expires) => [
      `لن يظهر إعلانك «${title}» ابتداءً من ${expires}.`,
      "إذا كان المنتج لا يزال متاحًا، جدّد الإعلان مجانًا من «إعلاناتي»: يبدأ مدة جديدة ويعود إلى أعلى النتائج. وإذا بعته، علّمه كمُباع.",
    ],
    button: "تجديد إعلاني",
    view: "عرض الإعلان:",
    closing: "تتلقى هذا البريد لأن إعلانك يقترب من نهاية مدة نشره.",
  },
};

export function listingExpiringSoon(data: TemplateData["listingExpiringSoon"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.title),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data.title, formatDate(data.expiresAt, ctx.locale)),
    action: { label: copy.button, url: pageUrl(ctx, "mes-annonces") },
    links: [{ label: copy.view, url: data.url }],
    closing: [copy.closing],
  });
}
