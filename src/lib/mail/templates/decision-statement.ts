import { decisionTemplate, fillTemplateText } from "@/config/decision-templates";
import { APPEAL_PAGE, APPEAL_TOKEN_PARAM } from "@/lib/decisions/contracts";
import type { DecisionAutomation, DecisionSource } from "../types";
import { formatDay, pageUrl, type MailLocale, type TemplateContext } from "./layout";

// Shared sentences of the decision mails (art. 17 DSA statement of reasons, art. 16(5) reporter
// outcome, art. 20 appeals; design phase-5 D13-D16): facts and ground from the template registry
// (src/config/decision-templates.ts) in the recipient's language, the source of the decision
// (never the reporter's identity), the automation used, the redress, the neutral host line.

/** Signed appeal link page in the recipient's locale (U2 builds `/{locale}/recours`). */
export function appealUrl(ctx: TemplateContext, token: string): string {
  return pageUrl(ctx, `${APPEAL_PAGE}?${APPEAL_TOKEN_PARAM}=${encodeURIComponent(token)}`);
}

const COPY: Record<
  MailLocale,
  {
    facts: string;
    details: (text: string) => string;
    ground: (ref: string, explanation: string) => string;
    source: Record<DecisionSource, string>;
    automation: { full: string; detected: string; human: string };
    redress: (deadline: string) => string;
    authorityRedress: string;
    host: string;
    reference: (id: string) => string;
    appealButton: string;
  }
> = {
  fr: {
    facts: "Faits constatés : ",
    details: (text) => `Précisions du modérateur : ${text}`,
    ground: (ref, explanation) => `Fondement : ${ref}. ${upperFirst(explanation)}.`,
    source: {
      notice: "Cette décision fait suite à un signalement.",
      own_initiative: "Nous avons agi de notre propre initiative, lors d'un contrôle de notre équipe.",
      authority_order: "Cette décision fait suite à une injonction d'une autorité compétente.",
    },
    automation: {
      full: "Cette décision a été prise automatiquement, sans intervention humaine. Un modérateur la réexaminera si vous la contestez.",
      detected: "Le contenu a été repéré par un outil automatisé, puis examiné et décidé par un modérateur.",
      human: "Cette décision a été prise par un modérateur de Joutiya.",
    },
    redress: (deadline) =>
      `Vous pouvez contester cette décision gratuitement, en ligne, jusqu'au ${deadline}, avec le bouton ci-dessous. Une autre personne que celle qui a décidé la réexaminera et vous répondra sous 14 jours. Vous pouvez aussi saisir le tribunal compétent.`,
    authorityRedress: "Cette mesure exécute l'injonction d'une autorité : vous pouvez la contester devant les juridictions de l'État qui l'a émise.",
    host: "Joutiya héberge les contenus de ses utilisateurs sans en être l'auteur et n'est pas partie aux échanges ni aux transactions entre utilisateurs.",
    reference: (id) => `Référence de la décision : ${id}.`,
    appealButton: "Contester la décision",
  },
  ar: {
    facts: "الوقائع المسجّلة: ",
    details: (text) => `توضيحات المشرف: ${text}`,
    ground: (ref, explanation) => `الأساس: ${ref}. ${explanation}.`,
    source: {
      notice: "اتُّخذ هذا القرار إثر تبليغ.",
      own_initiative: "تصرّفنا بمبادرة منّا خلال مراقبة يقوم بها فريقنا.",
      authority_order: "اتُّخذ هذا القرار تنفيذًا لأمر صادر عن سلطة مختصة.",
    },
    automation: {
      full: "اتُّخذ هذا القرار آليًا دون تدخل بشري. سيعيد مشرف فحصه إذا طعنت فيه.",
      detected: "رُصد المحتوى بأداة آلية، ثم فحصه مشرف واتخذ القرار.",
      human: "اتخذ هذا القرار مشرف لدى Joutiya.",
    },
    redress: (deadline) =>
      `يمكنك الطعن في هذا القرار مجانًا وعبر الإنترنت إلى غاية ${deadline} بواسطة الزر أدناه. سيعيد فحصه شخص آخر غير الذي اتخذه، وسيجيبك خلال 14 يومًا. يمكنك أيضًا اللجوء إلى المحكمة المختصة.`,
    authorityRedress: "ينفّذ هذا الإجراء أمرًا صادرًا عن سلطة: يمكنك الطعن فيه أمام محاكم الدولة التي أصدرته.",
    host: "تستضيف Joutiya محتويات مستخدميها دون أن تكون كاتبتها، وليست طرفًا في التبادلات أو المعاملات بين المستخدمين.",
    reference: (id) => `مرجع القرار: ${id}.`,
    appealButton: "الطعن في القرار",
  },
};

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface StatementInput {
  templateId: string;
  details: string | null;
  durationDays: number | null;
  source: DecisionSource;
  automated: DecisionAutomation;
  decisionId: string;
}

/** Facts, ground, source and automation of a decision, as mail paragraphs. */
export function statementLines(input: StatementInput, lang: MailLocale): string[] {
  const copy = COPY[lang];
  const template = decisionTemplate(input.templateId);
  const values = input.durationDays !== null ? { days: input.durationDays } : {};
  const lines: string[] = [];
  if (template) {
    lines.push(`${copy.facts}${fillTemplateText(template.facts[lang], values).replace(/[.\s]+$/, "")}.`);
    if (input.details) lines.push(copy.details(input.details));
    lines.push(copy.ground(template.ground.ref, fillTemplateText(template.explanation[lang], values).replace(/[.\s]+$/, "")));
  } else if (input.details) {
    lines.push(copy.details(input.details));
  }
  lines.push(copy.source[input.source]);
  lines.push(input.automated.decision ? copy.automation.full : input.automated.detection ? copy.automation.detected : copy.automation.human);
  return lines;
}

/** The redress paragraph: the appeal (6 months, another person, 14 days) or, for an authority order, the courts of the issuing State. */
export function redressLine(lang: MailLocale, input: { source: DecisionSource; appealDeadline: string; locale: TemplateContext["locale"] }): string {
  const copy = COPY[lang];
  return input.source === "authority_order" ? copy.authorityRedress : copy.redress(formatDay(input.appealDeadline, input.locale));
}

export function hostLine(lang: MailLocale): string {
  return COPY[lang].host;
}

export function referenceLine(lang: MailLocale, decisionId: string): string {
  return COPY[lang].reference(decisionId);
}

export function appealButton(lang: MailLocale): string {
  return COPY[lang].appealButton;
}
