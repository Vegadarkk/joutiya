import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// A shop's social links hidden or restored by a moderator (report « Lien de réseau social
// suspect », src/lib/pro/social-links.ts): the owner gets the reason (art. 17 DSA).

type Data = TemplateData["socialLinksNotice"];

interface Copy {
  subject: Record<Data["kind"], string>;
  body: (data: Data) => string[];
  button: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: { hidden: "Réseaux sociaux de votre boutique masqués", restored: "Réseaux sociaux de votre boutique rétablis" },
    body: (data) =>
      data.kind === "hidden"
        ? [
            `Notre équipe de modération a masqué les liens vers les réseaux sociaux de la boutique « ${data.shopName} ».`,
            `Motif : ${data.reason ?? ""}`,
            "Votre vitrine et vos annonces restent en ligne. Corrigez vos liens depuis votre espace Pro et répondez à cet e-mail pour demander leur rétablissement.",
          ]
        : [`Les liens vers les réseaux sociaux de la boutique « ${data.shopName} » sont de nouveau visibles sur sa vitrine.`],
    button: "Ouvrir mon espace Pro",
  },
  ar: {
    subject: { hidden: "تم إخفاء الشبكات الاجتماعية لمتجرك", restored: "عادت الشبكات الاجتماعية لمتجرك" },
    body: (data) =>
      data.kind === "hidden"
        ? [
            `أخفى فريق الإشراف روابط الشبكات الاجتماعية لمتجر «${data.shopName}».`,
            `السبب: ${data.reason ?? ""}`,
            "تبقى واجهة متجرك وإعلاناتك منشورة. صحّح روابطك من فضائك المهني وردّ على هذا البريد لطلب إعادتها.",
          ]
        : [`عادت روابط الشبكات الاجتماعية لمتجر «${data.shopName}» للظهور على واجهته.`],
    button: "فتح فضائي المهني",
  },
};

export function socialLinksNotice(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject[data.kind],
    title: copy.subject[data.kind],
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data),
    action: { label: copy.button, url: pageUrl(ctx, "pro") },
    closing: [],
  });
}
