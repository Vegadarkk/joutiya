import type { TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// A review held for sensitive data (vitrine-avis §3) was checked by a moderator and published: it
// now shows on the seller's storefront. The author was told at once that it would be checked first.

type Data = TemplateData["reviewPublished"];

interface Copy {
  subject: (seller: string) => string;
  title: string;
  body: (seller: string) => string[];
  button: string;
  mine: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (seller) => `Votre avis sur ${seller} est publié`,
    title: "Votre avis est publié",
    body: (seller) => [
      `Un modérateur a relu votre avis sur ${seller} : il est maintenant visible sur sa vitrine et compte dans sa note moyenne.`,
      "Le vendeur peut y répondre une fois. Vous pouvez supprimer votre avis à tout moment depuis « Mes avis ».",
    ],
    button: "Voir la vitrine",
    mine: "Mes avis :",
  },
  ar: {
    subject: (seller) => `نُشر تقييمك لـ ${seller}`,
    title: "نُشر تقييمك",
    body: (seller) => [
      `راجع أحد المشرفين تقييمك لـ ${seller}، وهو ظاهر الآن على واجهته ويُحتسب في متوسط تقييمه.`,
      "يمكن للبائع الرد عليه مرة واحدة. ويمكنك حذف تقييمك في أي وقت من «تقييماتي».",
    ],
    button: "عرض الواجهة",
    mine: "تقييماتي:",
  },
};

export function reviewPublished(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.sellerName),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data.sellerName),
    action: { label: copy.button, url: pageUrl(ctx, `profil/${data.sellerPublicId}#avis`) },
    links: [{ label: copy.mine, url: pageUrl(ctx, "mes-avis") }],
  });
}
