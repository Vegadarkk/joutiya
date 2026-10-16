import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Pro application refused by a moderator (phase 7 design §4): the moderator's reason, then how to
// correct and resubmit. The account stays an individual account; nothing it published changes.

interface Copy {
  subject: (shop: string) => string;
  title: string;
  body: (shop: string) => string;
  reason: (text: string) => string;
  button: string;
  closing: (contact: string) => string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (shop) => `Votre demande de compte Pro « ${shop} » n'a pas été validée`,
    title: "Demande de compte Pro refusée",
    body: (shop) => `Nous n'avons pas pu valider la demande de compte Pro « ${shop} ». Votre compte reste un compte particulier.`,
    reason: (text) => `Motif : ${text}`,
    button: "Corriger ma demande",
    closing: (contact) => `Vous pouvez corriger votre demande et la soumettre à nouveau. Pour contester cette décision, écrivez à ${contact}.`,
  },
  ar: {
    subject: (shop) => `لم يتم اعتماد طلب الحساب المهني «${shop}»`,
    title: "تم رفض طلب الحساب المهني",
    body: (shop) => `لم نتمكن من اعتماد طلب الحساب المهني «${shop}». يبقى حسابك حسابًا شخصيًا.`,
    reason: (text) => `السبب: ${text}`,
    button: "تصحيح طلبي",
    closing: (contact) => `يمكنك تصحيح طلبك وإرساله من جديد. للاعتراض على هذا القرار، راسلنا على ${contact}.`,
  },
};

export function proRejected(data: TemplateData["proRejected"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.shopName),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.body(data.shopName), copy.reason(data.reason)],
    action: { label: copy.button, url: pageUrl(ctx, "devenir-pro") },
    replyTo: data.contact,
    closing: [copy.closing(data.contact)],
  });
}
