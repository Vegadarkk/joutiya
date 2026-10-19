import type { TemplateData } from "../types";
import { formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Art. 23(2) DSA (design phase-5 D15): the prior warning after manifestly unfounded notices, then
// the notice that the reports of the account are not processed until a date. The account itself
// stays usable. Neutral wording: no content of the reports is repeated.

type Data = TemplateData["reporterWarning"];

interface Copy {
  subject: (data: Data, until: string) => string;
  title: Record<Data["kind"], string>;
  body: (data: Data, until: string) => string[];
  button: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (data, until) => (data.kind === "warning" ? "Avertissement concernant vos signalements" : `Vos signalements ne sont plus traités jusqu'au ${until}`),
    title: { warning: "Avertissement", suspended: "Signalements suspendus" },
    body: (data, until) =>
      data.kind === "warning"
        ? [
            `Plusieurs de vos signalements récents (${data.count} en ${data.windowDays} jours) ont été jugés manifestement infondés.`,
            "Un signalement doit être fait de bonne foi, pour un contenu que vous estimez illicite ou contraire à nos règles. Si un nouveau signalement manifestement infondé est constaté dans les 30 prochains jours, nous cesserons de traiter vos signalements pendant 30 jours.",
            "Vous pouvez continuer à utiliser Joutiya normalement.",
          ]
        : [
            "Malgré notre avertissement, un nouveau signalement manifestement infondé a été constaté.",
            `Nous ne traiterons pas vos signalements jusqu'au ${until}. Votre compte reste utilisable normalement.`,
            "Si vous pensez qu'il s'agit d'une erreur, répondez à notre équipe via la page de contact.",
          ],
    button: "Nos conditions générales",
  },
  ar: {
    subject: (data, until) => (data.kind === "warning" ? "إنذار بخصوص تبليغاتك" : `لن تُعالَج تبليغاتك إلى غاية ${until}`),
    title: { warning: "إنذار", suspended: "تعليق التبليغات" },
    body: (data, until) =>
      data.kind === "warning"
        ? [
            `اعتُبر عدد من تبليغاتك الأخيرة (${data.count} خلال ${data.windowDays} يومًا) غير مؤسَّس بشكل واضح.`,
            "يجب أن يكون التبليغ بحسن نية، بخصوص محتوى تعتبره غير قانوني أو مخالفًا لقواعدنا. إذا لوحظ تبليغ جديد غير مؤسَّس بشكل واضح خلال الثلاثين يومًا القادمة، سنتوقف عن معالجة تبليغاتك لمدة 30 يومًا.",
            "يمكنك مواصلة استعمال Joutiya بشكل عادي.",
          ]
        : [
            "رغم إنذارنا، لوحظ تبليغ جديد غير مؤسَّس بشكل واضح.",
            `لن نعالج تبليغاتك إلى غاية ${until}. يبقى حسابك قابلًا للاستعمال بشكل عادي.`,
            "إذا كنت تعتقد أن الأمر خطأ، تواصل مع فريقنا عبر صفحة الاتصال.",
          ],
    button: "الشروط العامة",
  },
};

export function reporterWarning(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const until = data.until ? formatDay(data.until, ctx.locale) : "";
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data, until),
    title: copy.title[data.kind],
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data, until),
    action: { label: copy.button, url: pageUrl(ctx, "legal/cgu") },
  });
}
