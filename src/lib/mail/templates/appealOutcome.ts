import type { TemplateData } from "../types";
import { hostLine, referenceLine } from "./decision-statement";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Appeal decided (art. 20(5) DSA, design phase-5 D16): reviewed by another moderator, upheld or
// reversed, the reviewer's reasons (sent as written), and the remaining redress (the courts).

type Data = TemplateData["appealOutcome"];

interface Copy {
  subject: string;
  title: string;
  hello: string;
  reviewed: (date: string) => string;
  result: (data: Data) => string;
  reasons: (note: string) => string;
  redress: string;
  button: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: "Résultat de votre recours",
    title: "Recours examiné",
    hello: "Bonjour,",
    reviewed: (date) => `Nous avons réexaminé la décision contestée le ${date}. Ce réexamen a été fait par un modérateur différent de celui qui l'avait prise.`,
    result: (data) =>
      data.outcome === "upheld"
        ? "Résultat : la décision est confirmée."
        : data.by === "affected"
          ? "Résultat : la décision est annulée et la mesure est levée."
          : "Résultat : votre recours est accepté et une nouvelle décision a été prise sur le contenu signalé.",
    reasons: (note) => `Motifs : ${note}`,
    redress: "Vous pouvez encore saisir le tribunal compétent.",
    button: "Vos droits et obligations",
  },
  ar: {
    subject: "نتيجة طعنك",
    title: "تم فحص الطعن",
    hello: "مرحبًا،",
    reviewed: (date) => `أعدنا فحص القرار المطعون فيه بتاريخ ${date}. قام بهذا الفحص مشرف غير الذي اتخذ القرار.`,
    result: (data) =>
      data.outcome === "upheld" ? "النتيجة: تم تأكيد القرار." : data.by === "affected" ? "النتيجة: أُلغي القرار ورُفع الإجراء." : "النتيجة: قُبل طعنك واتُّخذ قرار جديد بشأن المحتوى المبلَّغ عنه.",
    reasons: (note) => `الأسباب: ${note}`,
    redress: "يمكنك دائمًا اللجوء إلى المحكمة المختصة.",
    button: "حقوقك وواجباتك",
  },
};

export function appealOutcome(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: data.displayName ? GREETING[ctx.lang](data.displayName) : copy.hello,
    paragraphs: [copy.reviewed(formatDate(data.reviewedAt, ctx.locale)), copy.result(data), copy.reasons(data.note), copy.redress],
    action: { label: copy.button, url: pageUrl(ctx, "legal/droits-et-obligations") },
    closing: [hostLine(ctx.lang), referenceLine(ctx.lang, data.decisionId)],
  });
}
