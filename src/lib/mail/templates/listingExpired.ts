import type { TemplateData } from "../types";
import { formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// The listing expired (design D16): off the results, renewable for free until purgeAt, then
// deleted with its photos (retention-purge).

const COPY: Record<MailLocale, { subject: (title: string) => string; title: string; body: (title: string, purge: string) => string[]; button: string }> = {
  fr: {
    subject: (title) => `Votre annonce « ${title} » a expiré`,
    title: "Annonce expirée",
    body: (title, purge) => [
      `Votre annonce « ${title} » est arrivée au terme de sa durée de publication : elle n'apparaît plus dans les résultats.`,
      `Vous pouvez la renouveler gratuitement depuis « Mes annonces » jusqu'au ${purge}. Après cette date, elle sera supprimée définitivement, avec ses photos.`,
    ],
    button: "Renouveler mon annonce",
  },
  ar: {
    subject: (title) => `انتهت مدة إعلانك «${title}»`,
    title: "انتهت مدة الإعلان",
    body: (title, purge) => [
      `وصل إعلانك «${title}» إلى نهاية مدة نشره ولم يعد يظهر في النتائج.`,
      `يمكنك تجديده مجانًا من «إعلاناتي» حتى ${purge}. بعد هذا التاريخ سيُحذف نهائيًا مع صوره.`,
    ],
    button: "تجديد إعلاني",
  },
};

export function listingExpired(data: TemplateData["listingExpired"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.title),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data.title, formatDay(data.purgeAt, ctx.locale)),
    action: { label: copy.button, url: pageUrl(ctx, "mes-annonces") },
  });
}
