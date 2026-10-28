import { reportReason } from "@/config/report-reasons";
import type { TemplateData } from "../types";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Acknowledgement of a notice (art. 16(4) DSA, design D10): what was reported and why, when, its
// reference, the target delay, and that the decision will be notified (art. 16(5)). Neutral host
// wording; no content of the report is repeated (the explanation may hold personal data).

type TargetType = TemplateData["reportReceived"]["targetType"];

const COPY: Record<
  MailLocale,
  {
    subject: string;
    title: string;
    hello: string;
    target: Record<TargetType, string>;
    received: (target: string, reason: string, at: string, reference: string) => string;
    delay: (hours: number) => string;
    review: (delay: string) => string;
    urgent: string;
    host: string;
    button: string;
  }
> = {
  fr: {
    subject: "Nous avons bien reçu votre signalement",
    title: "Signalement reçu",
    hello: "Bonjour,",
    target: { listing: "une annonce", user: "un profil", message: "un message", pro: "une boutique" },
    received: (target, reason, at, reference) => `Votre signalement concernant ${target}, pour le motif « ${reason} », a bien été reçu le ${at}. Sa référence : ${reference}.`,
    delay: (hours) => (hours <= 1 ? "en priorité, dans l'heure" : hours < 48 ? `sous ${hours} heures` : `sous ${Math.round(hours / 24)} jours`),
    review: (delay) => `Notre équipe de modération l'examinera ${delay}. Nous vous informerons par e-mail de la décision prise et des moyens de la contester.`,
    urgent: "En cas de danger immédiat, contactez les autorités (police : 19, Gendarmerie royale : 177).",
    host: "Joutiya héberge les annonces et les messages de ses utilisateurs sans en être l'auteur : nous traitons les contenus signalés selon la loi et nos conditions générales.",
    button: "Nos conseils de sécurité",
  },
  ar: {
    subject: "توصلنا بتبليغك",
    title: "تم استلام التبليغ",
    hello: "مرحبًا،",
    target: { listing: "إعلان", user: "حساب", message: "رسالة", pro: "متجر" },
    received: (target, reason, at, reference) => `توصلنا بتبليغك بخصوص ${target} بسبب «${reason}» بتاريخ ${at}. مرجعه: ${reference}.`,
    delay: (hours) => (hours <= 1 ? "بأولوية خلال ساعة" : hours < 48 ? `خلال ${hours} ساعة` : `خلال ${Math.round(hours / 24)} أيام`),
    review: (delay) => `سيدرسه فريق الإشراف ${delay}. سنخبرك عبر البريد الإلكتروني بالقرار المتخذ وبطرق الطعن فيه.`,
    urgent: "في حالة خطر وشيك، اتصل بالسلطات (الشرطة: 19، الدرك الملكي: 177).",
    host: "تستضيف Joutiya إعلانات ورسائل مستخدميها دون أن تكون كاتبتها: نتعامل مع المحتويات المبلغ عنها وفقًا للقانون ولشروطنا العامة.",
    button: "نصائح الأمان",
  },
};

export function reportReceived(data: TemplateData["reportReceived"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const reason = reportReason(data.reasonId)?.label[ctx.lang] ?? data.reasonId;
  const paragraphs = [copy.received(copy.target[data.targetType], reason, formatDate(data.receivedAt, ctx.locale), data.reportId), copy.review(copy.delay(data.slaHours))];
  if (data.urgent) paragraphs.push(copy.urgent);
  paragraphs.push(copy.host);
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: data.displayName ? GREETING[ctx.lang](data.displayName) : copy.hello,
    paragraphs,
    action: { label: copy.button, url: pageUrl(ctx, "legal/confiance-et-securite") },
  });
}
