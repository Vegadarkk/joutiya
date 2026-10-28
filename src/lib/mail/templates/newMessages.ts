import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type MailSection, type TemplateContext } from "./layout";

// Grouped new-messages mail (design D21, bulk priority): sent by the message-digest job 30 minutes
// after the first unread message when the account was not active meanwhile, at most once every 6
// hours. The unread count and up to 3 conversations (listing title, the other member's name):
// never the text of a message, so a mail never carries a scam link or a phone number. The safety
// line repeats the neutral-host advice; the preference lives in the account settings.

interface Copy {
  subject: (count: number) => string;
  title: string;
  lead: (count: number) => string;
  heading: string;
  from: (name: string) => string;
  button: string;
  safety: string;
  closing: string;
  settings: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (count) => (count === 1 ? "Vous avez reçu un nouveau message" : `Vous avez ${count} messages non lus`),
    title: "Nouveaux messages",
    lead: (count) => (count === 1 ? "Un membre vous a écrit sur Joutiya." : `Des membres vous ont écrit sur Joutiya : ${count} messages vous attendent.`),
    heading: "Conversations",
    from: (name) => `De ${name}`,
    button: "Lire mes messages",
    safety: "Pour votre sécurité, échangez sur la messagerie Joutiya et ne versez jamais d'acompte avant d'avoir vu l'article.",
    closing: "Vous recevez cet e-mail parce que des messages vous attendent. Un e-mail toutes les 6 heures au plus, jamais le texte des messages.",
    settings: "Choisir de recevoir ou non ces e-mails, dans les paramètres de votre compte :",
  },
  ar: {
    subject: (count) => (count === 1 ? "وصلتك رسالة جديدة" : `رسائل غير مقروءة في انتظارك: ${count}`),
    title: "رسائل جديدة",
    lead: (count) => (count === 1 ? "راسلك أحد الأعضاء على Joutiya." : `راسلك أعضاء على Joutiya، وعدد الرسائل غير المقروءة: ${count}.`),
    heading: "المحادثات",
    from: (name) => `من ${name}`,
    button: "قراءة رسائلي",
    safety: "لسلامتك، تواصل عبر رسائل Joutiya ولا تدفع أي عربون قبل معاينة المنتوج.",
    closing: "تتلقى هذا البريد لأن رسائل في انتظارك. رسالة واحدة كل 6 ساعات على الأكثر، دون نص الرسائل.",
    settings: "اختر تلقي هذه الرسائل أو إيقافها من إعدادات حسابك:",
  },
};

export function newMessages(data: TemplateData["newMessages"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const inbox = pageUrl(ctx, "messages");
  const count = Math.max(1, Math.floor(data.count));
  const sections: MailSection[] =
    data.conversations.length > 0
      ? [{ heading: copy.heading, items: data.conversations.slice(0, 3).map((item) => ({ title: item.listingTitle, detail: copy.from(item.counterpartName), url: inbox })) }]
      : [];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(count),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.lead(count)],
    sections,
    action: { label: copy.button, url: inbox },
    closing: [copy.safety, copy.closing],
    links: [{ label: copy.settings, url: pageUrl(ctx, "parametres") }],
  });
}
