import { LOCALE_TAGS, SITE_NAME } from "@/config/site";
import type { TemplateData } from "../types";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Appointment reminder (architecture §5, 28 Oct; job appointment-reminders): the day before and two
// hours before a confirmed slot, to both participants unless they turned the messaging mails off.
// The time is Morocco's; the place is the members' own text with its links masked. The safety
// line repeats the neutral-host advice: no deposit, a public place.

type Kind = TemplateData["appointmentReminder"]["kind"];

interface Copy {
  subject: (kind: string, when: string) => string;
  title: string;
  lead: (kind: string, name: string, listing: string) => string;
  when: string;
  place: string;
  maskedLink: string;
  kinds: Record<Kind, string>;
  button: string;
  safety: string;
  closing: string;
  settings: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (kind, when) => `Rappel : ${kind} ${when}`,
    title: "Rappel de rendez-vous",
    lead: (kind, name, listing) => `Votre ${kind} avec ${name} pour « ${listing} » approche.`,
    when: "Quand (heure du Maroc)",
    place: "Lieu",
    maskedLink: "[lien masqué]",
    kinds: { meeting: "rendez-vous", visit: "visite", test_drive: "essai", pickup: "retrait" },
    button: "Ouvrir la conversation",
    safety: `Pour votre sécurité, retrouvez-vous dans un lieu public ou fréquenté et ne versez jamais d'acompte. ${SITE_NAME} n'intervient pas dans la transaction.`,
    closing: "Vous ne pouvez plus venir ? Annulez ou reportez depuis la conversation pour prévenir l'autre membre.",
    settings: "Choisir de recevoir ou non les e-mails de la messagerie, dans les paramètres de votre compte :",
  },
  ar: {
    subject: (kind, when) => `تذكير: ${kind} ${when}`,
    title: "تذكير بموعد",
    lead: (kind, name, listing) => `يقترب موعد ${kind} مع ${name} بخصوص «${listing}».`,
    when: "الموعد (بتوقيت المغرب)",
    place: "المكان",
    maskedLink: "[رابط مخفي]",
    kinds: { meeting: "اللقاء", visit: "الزيارة", test_drive: "التجربة", pickup: "الاستلام" },
    button: "فتح المحادثة",
    safety: `لسلامتك، التقِ في مكان عام أو مزدحم ولا تدفع أي عربون. ${SITE_NAME} ليست طرفا في المعاملة.`,
    closing: "لن تتمكن من الحضور؟ ألغِ الموعد أو أجّله من المحادثة لإخبار العضو الآخر.",
    settings: "اختر تلقي رسائل المراسلة أو إيقافها من إعدادات حسابك:",
  },
};

/** "jeudi 30 octobre à 14:30" in Morocco's time zone. */
export function formatAppointmentTime(iso: string, lang: MailLocale): string {
  const date = new Date(iso);
  const tag = lang === "ar" ? LOCALE_TAGS.ar : LOCALE_TAGS.fr;
  const day = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: moroccoTimeZone(date.getTime()) }).format(date);
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: moroccoTimeZone(date.getTime()) }).format(date);
  return lang === "ar" ? `${day} على الساعة ${time}` : `${day} à ${time}`;
}

export function appointmentReminder(data: TemplateData["appointmentReminder"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const url = pageUrl(ctx, `messages/${data.cid}`);
  const kind = copy.kinds[data.kind];
  const when = formatAppointmentTime(data.startsAt, ctx.lang);
  const place = data.place ? data.place.replaceAll("⟦url⟧", copy.maskedLink) : null;
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(kind, when),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.lead(kind, data.counterpartName, data.listingTitle)],
    sections: [{ heading: copy.when, items: [{ title: when, ...(place ? { detail: `${copy.place} : ${place}` } : {}), url }] }],
    action: { label: copy.button, url },
    closing: [copy.safety, copy.closing],
    links: [{ label: copy.settings, url: pageUrl(ctx, "parametres") }],
  });
}
