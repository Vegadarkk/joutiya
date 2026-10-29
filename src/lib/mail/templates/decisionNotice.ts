import type { TemplateData } from "../types";
import { appealButton, appealUrl, hostLine, redressLine, referenceLine, statementLines } from "./decision-statement";
import { formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Statement of reasons of a restrictive decision (art. 17 DSA, design phase-5 D13-D14): the
// measure, the facts, the ground, the source and the automation used, then how to contest it (the
// signed appeal link, art. 20; the issuing State's courts for an authority order). The reporter is
// never named.

type Data = TemplateData["decisionNotice"];

interface Copy {
  subject: (data: Data, until: string) => string;
  title: Record<Data["action"], string>;
  measure: (data: Data, until: string) => string;
  rulesButton: string;
}

const quoted = (lang: MailLocale, title: string | null) => (title ? (lang === "fr" ? ` « ${title} »` : ` «${title}»`) : "");
/** " sur Salma" / " عن Salma": the seller a hidden review was about. */
const about = (lang: MailLocale, name: string | null) => (name ? (lang === "fr" ? ` sur ${name}` : ` عن ${name}`) : "");

/** "7 أيام", "30 يومًا" (Arabic plural of the counted noun). */
const arabicDays = (days: number) => `${days} ${days >= 3 && days <= 10 ? "أيام" : "يومًا"}`;

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (data, until) => {
      switch (data.action) {
        case "remove":
          if (data.targetType === "review") return `Votre avis${about("fr", data.title)} a été masqué`;
          return data.targetType === "message" ? "Un de vos messages a été masqué" : `Votre annonce${quoted("fr", data.title)} a été retirée`;
        case "restrict_visibility":
          return `La visibilité de votre annonce${quoted("fr", data.title)} est restreinte`;
        case "warn":
          return "Avertissement concernant votre compte Joutiya";
        case "suspend_account":
          return `Votre compte Joutiya est suspendu jusqu'au ${until}`;
        case "ban":
          return "Votre compte Joutiya est fermé";
      }
    },
    title: { remove: "Contenu retiré", restrict_visibility: "Visibilité restreinte", warn: "Avertissement", suspend_account: "Compte suspendu", ban: "Compte fermé" },
    measure: (data, until) => {
      switch (data.action) {
        case "remove":
          if (data.targetType === "review") return `Mesure : votre avis${about("fr", data.title)} a été masqué. Il n'est plus visible et ne compte plus dans la note du vendeur.`;
          return data.targetType === "message"
            ? "Mesure : un de vos messages a été masqué. Votre interlocuteur ne peut plus le lire."
            : `Mesure : votre annonce${quoted("fr", data.title)} a été retirée. Elle n'est plus visible sur Joutiya.`;
        case "restrict_visibility":
          return `Mesure : votre annonce${quoted("fr", data.title)} n'apparaît plus dans les recherches ni sur sa page publique.`;
        case "warn":
          return "Mesure : avertissement. Aucune restriction n'est appliquée à votre compte à ce stade.";
        case "suspend_account":
          return `Mesure : votre compte est suspendu pour ${data.durationDays ?? ""} jours, jusqu'au ${until}. Pendant la suspension, vous pouvez lire vos conversations et contester cette décision ; vos annonces en ligne sont mises en pause et reprendront à la fin de la suspension si elles n'ont pas expiré.`;
        case "ban":
          return "Mesure : votre compte Joutiya est fermé définitivement. Vos annonces sont retirées et vous ne pouvez plus vous connecter.";
      }
    },
    rulesButton: "Lire nos conditions générales",
  },
  ar: {
    subject: (data, until) => {
      switch (data.action) {
        case "remove":
          if (data.targetType === "review") return `تم إخفاء تقييمك${about("ar", data.title)}`;
          return data.targetType === "message" ? "تم إخفاء إحدى رسائلك" : `تم سحب إعلانك${quoted("ar", data.title)}`;
        case "restrict_visibility":
          return `تم تقييد ظهور إعلانك${quoted("ar", data.title)}`;
        case "warn":
          return "إنذار بخصوص حسابك على Joutiya";
        case "suspend_account":
          return `تم توقيف حسابك على Joutiya إلى غاية ${until}`;
        case "ban":
          return "تم إغلاق حسابك على Joutiya";
      }
    },
    title: { remove: "سحب محتوى", restrict_visibility: "تقييد الظهور", warn: "إنذار", suspend_account: "توقيف الحساب", ban: "إغلاق الحساب" },
    measure: (data, until) => {
      switch (data.action) {
        case "remove":
          if (data.targetType === "review") return `الإجراء: تم إخفاء تقييمك${about("ar", data.title)}، ولم يعد ظاهرًا ولا يُحتسب في تقييم البائع.`;
          return data.targetType === "message" ? "الإجراء: تم إخفاء إحدى رسائلك، ولم يعد بإمكان محاورك قراءتها." : `الإجراء: تم سحب إعلانك${quoted("ar", data.title)}، ولم يعد ظاهرًا على Joutiya.`;
        case "restrict_visibility":
          return `الإجراء: لم يعد إعلانك${quoted("ar", data.title)} يظهر في نتائج البحث ولا في صفحته العامة.`;
        case "warn":
          return "الإجراء: إنذار. لا يُطبَّق أي تقييد على حسابك في هذه المرحلة.";
        case "suspend_account":
          return `الإجراء: تم توقيف حسابك لمدة ${arabicDays(data.durationDays ?? 0)} إلى غاية ${until}. خلال التوقيف يمكنك قراءة محادثاتك والطعن في هذا القرار؛ وتُوقف إعلاناتك المنشورة مؤقتًا وتُستأنف عند نهاية التوقيف إن لم تنته صلاحيتها.`;
        case "ban":
          return "الإجراء: تم إغلاق حسابك على Joutiya نهائيًا. سُحبت إعلاناتك ولم يعد بإمكانك تسجيل الدخول.";
      }
    },
    rulesButton: "قراءة الشروط العامة",
  },
};

export function decisionNotice(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const until = data.until ? formatDay(data.until, ctx.locale) : "";
  const statement = statementLines(
    { templateId: data.templateId, details: data.details, durationDays: data.durationDays, source: data.source, automated: data.automated, decisionId: data.decisionId },
    ctx.lang,
  );
  const redress = redressLine(ctx.lang, { source: data.source, appealDeadline: data.appealDeadline, locale: ctx.locale });
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data, until),
    title: copy.title[data.action],
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.measure(data, until), ...statement, redress],
    action: data.appealToken ? { label: appealButton(ctx.lang), url: appealUrl(ctx, data.appealToken) } : { label: copy.rulesButton, url: pageUrl(ctx, "legal/cgu") },
    closing: [hostLine(ctx.lang), referenceLine(ctx.lang, data.decisionId)],
  });
}
