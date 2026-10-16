import type { TemplateData } from "../types";
import { appealButton, appealUrl, hostLine, referenceLine } from "./decision-statement";
import { formatDate, formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// What became of a notice (art. 16(5) DSA, design phase-5 D13): the decision, whether automated
// means were used, and how to contest it (art. 20: the notifier may complain too, signed link).
// Measures against the other user are named only as far as needed ("une sanction").

type Data = TemplateData["reportOutcome"];

interface Copy {
  subject: string;
  title: string;
  hello: string;
  target: Record<Data["targetType"], string>;
  examined: (date: string, target: string, reference: string) => string;
  measure: Record<Data["action"], string>;
  dismissed: string;
  automated: { full: string; detected: string; human: string };
  redress: (deadline: string) => string;
  noAppeal: string;
  safety: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: "Suite donnée à votre signalement",
    title: "Décision sur votre signalement",
    hello: "Bonjour,",
    target: { listing: "une annonce", user: "un profil", message: "un message", pro: "une boutique" },
    examined: (date, target, reference) => `Nous avons examiné votre signalement du ${date} concernant ${target} (référence ${reference}).`,
    measure: {
      remove: "Décision : le contenu signalé a été retiré.",
      restrict_visibility: "Décision : la visibilité du contenu signalé a été restreinte.",
      warn: "Décision : une mesure a été prise à l'encontre du compte concerné.",
      suspend_account: "Décision : une sanction a été prise à l'encontre du compte concerné.",
      ban: "Décision : une sanction a été prise à l'encontre du compte concerné.",
      restore: "Décision : aucune mesure n'a été prise.",
      no_action: "Décision : aucune mesure n'a été prise.",
    },
    dismissed: "Après examen, le contenu ne nous paraît ni illicite ni contraire à nos conditions générales d'utilisation.",
    automated: {
      full: "Cette décision a été prise automatiquement.",
      detected: "Un outil automatisé a aidé à repérer le contenu ; un modérateur a pris la décision.",
      human: "Cette décision a été prise par un modérateur.",
    },
    redress: (deadline) => `Si vous n'êtes pas d'accord, vous pouvez contester cette décision gratuitement, en ligne, jusqu'au ${deadline}, avec le bouton ci-dessous, ou saisir le tribunal compétent.`,
    noAppeal: "Merci pour votre vigilance.",
    safety: "Nos conseils de sécurité",
  },
  ar: {
    subject: "مآل تبليغك",
    title: "القرار بشأن تبليغك",
    hello: "مرحبًا،",
    target: { listing: "إعلان", user: "حساب", message: "رسالة", pro: "متجر" },
    examined: (date, target, reference) => `فحصنا تبليغك بتاريخ ${date} بخصوص ${target} (المرجع ${reference}).`,
    measure: {
      remove: "القرار: تم سحب المحتوى المبلَّغ عنه.",
      restrict_visibility: "القرار: تم تقييد ظهور المحتوى المبلَّغ عنه.",
      warn: "القرار: اتُّخذ إجراء في حق الحساب المعني.",
      suspend_account: "القرار: اتُّخذت عقوبة في حق الحساب المعني.",
      ban: "القرار: اتُّخذت عقوبة في حق الحساب المعني.",
      restore: "القرار: لم يُتَّخذ أي إجراء.",
      no_action: "القرار: لم يُتَّخذ أي إجراء.",
    },
    dismissed: "بعد الفحص، لا يبدو لنا أن المحتوى غير قانوني أو مخالف لشروط الاستخدام العامة.",
    automated: {
      full: "اتُّخذ هذا القرار آليًا.",
      detected: "ساعدت أداة آلية في رصد المحتوى، واتخذ مشرف القرار.",
      human: "اتخذ هذا القرار مشرف.",
    },
    redress: (deadline) => `إذا لم توافق، يمكنك الطعن في هذا القرار مجانًا وعبر الإنترنت إلى غاية ${deadline} بواسطة الزر أدناه، أو اللجوء إلى المحكمة المختصة.`,
    noAppeal: "شكرًا على يقظتك.",
    safety: "نصائح الأمان",
  },
};

export function reportOutcome(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const paragraphs = [copy.examined(formatDate(data.reportedAt, ctx.locale), copy.target[data.targetType], data.reportId), copy.measure[data.action]];
  if (data.outcome === "dismissed") paragraphs.push(copy.dismissed);
  paragraphs.push(data.automated.decision ? copy.automated.full : data.automated.detection ? copy.automated.detected : copy.automated.human);
  paragraphs.push(data.appealToken ? copy.redress(formatDay(data.appealDeadline, ctx.locale)) : copy.noAppeal);
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: data.displayName ? GREETING[ctx.lang](data.displayName) : copy.hello,
    paragraphs,
    action: data.appealToken ? { label: appealButton(ctx.lang), url: appealUrl(ctx, data.appealToken) } : { label: copy.safety, url: pageUrl(ctx, "legal/confiance-et-securite") },
    closing: [hostLine(ctx.lang), referenceLine(ctx.lang, data.decisionId)],
  });
}
