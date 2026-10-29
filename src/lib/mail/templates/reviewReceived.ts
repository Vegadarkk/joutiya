import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// A buyer's review of the seller is published (vitrine-avis §2, bulk priority): the author's name,
// the note and the listing, never the text, so a mail never carries what a member wrote. The seller
// may answer once from "Mes avis"; the preference is the messaging one of the account settings.

type Data = TemplateData["reviewReceived"];

interface Copy {
  subject: (name: string) => string;
  title: string;
  lead: (data: Data) => string;
  reply: string;
  button: string;
  rules: string;
  closing: string;
}

const stars = (rating: number) => `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (name) => `${name} a laissé un avis sur votre vitrine`,
    title: "Nouvel avis sur votre vitrine",
    lead: (data) => `${data.authorName} a donné son avis après votre échange pour « ${data.listingTitle} » : ${stars(data.rating)} (${data.rating} sur 5).`,
    reply: "Vous pouvez y répondre une fois, publiquement, depuis « Mes avis ». Une réponse courtoise et factuelle rassure les prochains acheteurs.",
    button: "Voir l'avis et répondre",
    rules: "Règles des avis et signalement :",
    closing: "Si cet avis vous semble faux ou sans rapport avec l'échange, signalez-le depuis votre vitrine : un modérateur l'examine.",
  },
  ar: {
    subject: (name) => `ترك ${name} تقييمًا على واجهتك`,
    title: "تقييم جديد على واجهتك",
    lead: (data) => `قيّم ${data.authorName} تعامله معك بخصوص «${data.listingTitle}»: ${stars(data.rating)} (${data.rating} من 5).`,
    reply: "يمكنك الرد عليه مرة واحدة وبشكل علني من «تقييماتي». الرد المهذب والواقعي يطمئن المشترين المقبلين.",
    button: "عرض التقييم والرد",
    rules: "قواعد التقييمات والإبلاغ:",
    closing: "إذا بدا لك هذا التقييم زائفًا أو لا علاقة له بالمعاملة، أبلغ عنه من واجهتك وسيراجعه أحد المشرفين.",
  },
};

export function reviewReceived(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const rating = Math.min(5, Math.max(1, Math.round(data.rating)));
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.authorName),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.lead({ ...data, rating }), copy.reply],
    action: { label: copy.button, url: pageUrl(ctx, "mes-avis") },
    links: [{ label: copy.rules, url: pageUrl(ctx, "legal/avis-utilisateurs#signalement") }],
    closing: [copy.closing],
  });
}
