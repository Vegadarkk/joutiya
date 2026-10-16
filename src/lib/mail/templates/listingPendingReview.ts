import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";
import { statementParagraphs } from "./statement";

// Publication held by the pre-moderation (design D8): what happens next, then the art. 17 statement.

const COPY: Record<MailLocale, { subject: (title: string) => string; title: string; body: (title: string) => string[]; button: string }> = {
  fr: {
    subject: (title) => `Votre annonce « ${title} » est en cours de vérification`,
    title: "Annonce en cours de vérification",
    body: (title) => [
      `Votre annonce « ${title} » a bien été enregistrée, mais elle n'est pas encore visible : un modérateur doit la vérifier avant sa publication, en général sous 24 heures. Vous recevrez un e-mail dès sa décision.`,
    ],
    button: "Suivre mes annonces",
  },
  ar: {
    subject: (title) => `إعلانك «${title}» قيد المراجعة`,
    title: "الإعلان قيد المراجعة",
    body: (title) => [`تم تسجيل إعلانك «${title}»، لكنه غير ظاهر بعد: يجب أن يراجعه مشرف قبل نشره، عادةً في غضون 24 ساعة. ستتلقى بريدًا إلكترونيًا فور صدور قراره.`],
    button: "متابعة إعلاناتي",
  },
};

export function listingPendingReview(data: TemplateData["listingPendingReview"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.title),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [...copy.body(data.title), ...statementParagraphs(data.statement, ctx.lang)],
    action: { label: copy.button, url: pageUrl(ctx, "mes-annonces") },
  });
}
