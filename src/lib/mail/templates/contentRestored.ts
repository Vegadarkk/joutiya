import type { TemplateData } from "../types";
import { hostLine, referenceLine } from "./decision-statement";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Content shown again, or a preventive account restriction lifted (design phase-5 D13 "restore",
// AF §7 exit criterion "un signalement rejeté rétablit le contenu et prévient le vendeur"), after
// a dismissed report or a granted appeal.

type Data = TemplateData["contentRestored"];

interface Copy {
  subject: (data: Data) => string;
  title: string;
  body: (data: Data) => string;
  apology: string;
  button: Record<Data["targetType"], string>;
}

const quoted = (lang: MailLocale, title: string | null) => (title ? (lang === "fr" ? ` « ${title} »` : ` «${title}»`) : "");

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (data) =>
      data.targetType === "listing"
        ? `Votre annonce${quoted("fr", data.title)} est de nouveau visible`
        : data.targetType === "message"
          ? "Votre message est de nouveau visible"
          : data.targetType === "review"
            ? "Votre avis est de nouveau visible"
            : "Votre compte est rétabli",
    title: "Contenu rétabli",
    body: (data) => {
      const after = data.via === "appeal" ? "Après réexamen de votre recours" : "Après examen d'un signalement";
      if (data.targetType === "listing") return `${after}, nous avons rétabli votre annonce${quoted("fr", data.title)} : elle est de nouveau visible si elle est en ligne.`;
      if (data.targetType === "message") return `${after}, nous avons rétabli votre message : votre interlocuteur peut de nouveau le lire.`;
      if (data.targetType === "review") return `${after}, nous avons rétabli votre avis : il est de nouveau visible sur la vitrine du vendeur et compte dans sa note.`;
      return `${after}, nous avons levé les restrictions appliquées à votre compte et à vos annonces.`;
    },
    apology: "Nous vous prions de nous excuser pour la gêne occasionnée.",
    button: { listing: "Voir mes annonces", message: "Voir mes messages", user: "Voir mon compte", review: "Voir mes avis" },
  },
  ar: {
    subject: (data) =>
      data.targetType === "listing"
        ? `إعلانك${quoted("ar", data.title)} ظاهر من جديد`
        : data.targetType === "message"
          ? "رسالتك ظاهرة من جديد"
          : data.targetType === "review"
            ? "تقييمك ظاهر من جديد"
            : "تمت إعادة حسابك",
    title: "إعادة المحتوى",
    body: (data) => {
      const after = data.via === "appeal" ? "بعد إعادة فحص طعنك" : "بعد فحص تبليغ";
      if (data.targetType === "listing") return `${after}، أعدنا إعلانك${quoted("ar", data.title)}: أصبح ظاهرًا من جديد إن كان منشورًا.`;
      if (data.targetType === "message") return `${after}، أعدنا رسالتك: يمكن لمحاورك قراءتها من جديد.`;
      if (data.targetType === "review") return `${after}، أعدنا تقييمك: أصبح ظاهرًا من جديد في واجهة البائع ويُحتسب في تقييمه.`;
      return `${after}، رفعنا القيود المطبقة على حسابك وعلى إعلاناتك.`;
    },
    apology: "نعتذر عن الإزعاج.",
    button: { listing: "عرض إعلاناتي", message: "عرض رسائلي", user: "عرض حسابي", review: "عرض تقييماتي" },
  },
};

const PAGE: Record<Data["targetType"], string> = { listing: "mes-annonces", message: "messages", user: "parametres", review: "mes-avis" };

export function contentRestored(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.body(data), copy.apology],
    action: { label: copy.button[data.targetType], url: pageUrl(ctx, PAGE[data.targetType]) },
    closing: [hostLine(ctx.lang), referenceLine(ctx.lang, data.decisionId)],
  });
}
