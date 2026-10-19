import type { TemplateData } from "../types";
import { referenceLine } from "./decision-statement";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Appeal received (art. 20 DSA, design phase-5 D16): reference, date, the review by another person
// than the one who decided, the answer delay. Free of charge.

type Data = TemplateData["appealReceived"];

const COPY: Record<MailLocale, { subject: string; title: string; hello: string; received: (date: string) => string; review: (days: number) => string; free: string; button: string }> = {
  fr: {
    subject: "Nous avons bien reçu votre recours",
    title: "Recours reçu",
    hello: "Bonjour,",
    received: (date) => `Votre recours a bien été reçu le ${date}.`,
    review: (days) => `Une autre personne que celle qui a pris la décision le réexaminera. Nous vous répondrons par e-mail, de façon motivée, sous ${days} jours.`,
    free: "Le recours est gratuit. Vous n'avez rien d'autre à faire pour le moment.",
    button: "Vos droits et obligations",
  },
  ar: {
    subject: "توصلنا بطعنك",
    title: "تم استلام الطعن",
    hello: "مرحبًا،",
    received: (date) => `توصلنا بطعنك بتاريخ ${date}.`,
    review: (days) => `سيعيد فحصه شخص آخر غير الذي اتخذ القرار، وسنجيبك عبر البريد الإلكتروني بجواب معلَّل خلال ${days} يومًا.`,
    free: "الطعن مجاني، ولا يلزمك القيام بأي شيء آخر حاليًا.",
    button: "حقوقك وواجباتك",
  },
};

export function appealReceived(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: data.displayName ? GREETING[ctx.lang](data.displayName) : copy.hello,
    paragraphs: [copy.received(formatDate(data.receivedAt, ctx.locale)), copy.review(data.slaDays), copy.free],
    action: { label: copy.button, url: pageUrl(ctx, "legal/droits-et-obligations") },
    closing: [referenceLine(ctx.lang, data.decisionId)],
  });
}
