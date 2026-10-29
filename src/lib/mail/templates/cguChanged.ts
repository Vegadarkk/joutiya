import { LEGAL_VERSIONS } from "@/config/legal-versions";
import type { TemplateData } from "../types";
import { formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// CGU change notice (phase 6, D11; DSA art. 14 § 2), bulk priority, sent by the nightly cgu-notice
// job to members who accepted an earlier version, with the summary of the changes of that version
// (CGU §22.1). A service notice: no unsubscribe link.

type Data = TemplateData["cguChanged"];

const COPY: Record<MailLocale, { subject: string; title: string; body: (version: string, day: string) => string[]; changes: string; button: string; closing: string }> = {
  fr: {
    subject: "Nos conditions générales d'utilisation changent",
    title: "Nouvelles conditions générales d'utilisation",
    body: (version, day) => [
      `Nous avons mis à jour nos conditions générales d'utilisation (version ${version}). Elles s'appliquent à partir du ${day}.`,
      "Prenez un moment pour les lire : elles disent ce que vous pouvez publier, comment nous modérons les contenus et comment contester une décision.",
      "Si vous ne les acceptez pas, vous pouvez fermer votre compte à tout moment depuis vos paramètres et télécharger vos données avant.",
    ],
    changes: "Ce qui change :",
    button: "Lire les conditions",
    closing: "Vous recevez cet avis parce que vous avez un compte. C'est une information sur le service : elle n'a pas de lien de désinscription.",
  },
  ar: {
    subject: "تتغير شروط الاستخدام العامة",
    title: "شروط استخدام عامة جديدة",
    body: (version, day) => [
      `حدّثنا شروط الاستخدام العامة (النسخة ${version}). وتسري ابتداءً من ${day}.`,
      "خذ لحظة لقراءتها: فهي تبيّن ما يمكنك نشره، وكيف نراقب المحتوى، وكيف تعترض على قرار.",
      "إذا لم تقبلها، يمكنك إغلاق حسابك في أي وقت من الإعدادات وتنزيل بياناتك قبل ذلك.",
    ],
    changes: "ما الذي يتغير:",
    button: "قراءة الشروط",
    closing: "تتلقى هذا الإشعار لأن لديك حسابًا. إنه معلومة متعلقة بالخدمة، ولا يتضمن رابط إلغاء الاشتراك.",
  },
};

export function cguChanged(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const cgu = LEGAL_VERSIONS.cgu;
  const summary = cgu.version === data.version ? (cgu.summary?.[ctx.lang] ?? []) : [];
  // Noon UTC: the same calendar day in Casablanca.
  const body = copy.body(data.version, formatDay(`${data.effective}T12:00:00.000Z`, ctx.locale));
  const changes = summary.length > 0 ? [copy.changes, ...summary.map((line) => `• ${line}`)] : [];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [...body.slice(0, 1), ...changes, ...body.slice(1)],
    action: { label: copy.button, url: pageUrl(ctx, "legal/cgu") },
    closing: [copy.closing],
  });
}
