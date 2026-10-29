import { SITE_NAME } from "@/config/site";
import type { TemplateData } from "../types";
import { formatDate, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// « Payer chez le vendeur » (design phase-7/boutique-temporaire.md §2): the shop's owner is told of
// every change of its payment button. A new link turns active 24 hours after it was saved, so a
// hijacked account cannot divert payments without its owner hearing of it first.

type Data = TemplateData["sellerPaymentNotice"];

type ListingKind = Extract<Data["kind"], "changed" | "removed">;

interface Copy {
  subject: Record<Data["kind"], string>;
  body: (data: Data, at: string | null) => string[];
  button: string;
  notYou: string;
  /** A listing's own link (catalogue §6): always on a checked host, so always dated. */
  listing: { subject: Record<ListingKind, string>; body: (kind: ListingKind, title: string, host: string, at: string) => string[]; button: string; notYou: string };
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: {
      changed: "Nouveau lien de paiement pour votre boutique",
      removed: "Lien de paiement retiré de votre boutique",
      contact: "Coordonnées vendeur modifiées",
      suspended: "Bouton « Payer chez le vendeur » suspendu",
      restored: "Bouton « Payer chez le vendeur » rétabli",
      rejected: "Lien de paiement refusé",
    },
    body: (data, at) => {
      const shop = `« ${data.shopName} »`;
      switch (data.kind) {
        case "changed":
          return [
            `Un nouveau lien de paiement vers ${data.host} a été enregistré pour la boutique ${shop}.`,
            at
              ? `Il remplacera le lien actuel le ${at}. D'ici là, rien ne change pour vos acheteurs.`
              : `Ce site de paiement n'est pas encore vérifié par ${SITE_NAME} : le lien sera activé après notre vérification, 24 heures au plus tôt après son enregistrement.`,
          ];
        case "removed":
          return [`Le lien de paiement de la boutique ${shop} a été retiré. Le bouton « Payer chez le vendeur » n'apparaît plus sur vos annonces.`];
        case "contact":
          return [`L'adresse ou l'e-mail que la boutique ${shop} affiche à ses acheteurs a été modifié.`];
        case "suspended":
          return [`Le bouton « Payer chez le vendeur » de la boutique ${shop} a été suspendu par notre équipe de modération.`, `Motif : ${data.reason ?? ""}`, "Vos annonces restent en ligne. Répondez à cet e-mail pour en discuter."];
        case "restored":
          return [`Le bouton « Payer chez le vendeur » de la boutique ${shop} est de nouveau visible.`];
        case "rejected":
          return [`Le lien de paiement vers ${data.host} n'a pas été accepté pour la boutique ${shop}.`, `Motif : ${data.reason ?? ""}`, "Indiquez la page de paiement de votre banque ou d'un prestataire de paiement agréé."];
      }
    },
    button: "Gérer le paiement de ma boutique",
    notYou: "Si vous n'êtes pas à l'origine de ce changement, retirez le lien depuis votre espace Pro, changez votre mot de passe et écrivez-nous sans attendre.",
    listing: {
      subject: { changed: "Nouveau lien de paiement pour une annonce", removed: "Lien de paiement retiré d'une annonce" },
      body: (kind, title, host, at) =>
        kind === "changed"
          ? [`Un lien de paiement vers ${host} a été enregistré pour votre annonce « ${title} ».`, `Le bouton « Payer chez le vendeur » de cette annonce l'ouvrira à partir du ${at}. D'ici là, rien ne change pour vos acheteurs.`]
          : [`Le lien de paiement propre à votre annonce « ${title} » a été retiré. Son bouton « Payer chez le vendeur » ouvre de nouveau le lien de votre boutique, s'il y en a un.`],
      button: "Voir mes annonces",
      notYou: "Si vous n'êtes pas à l'origine de ce changement, retirez le lien depuis « Mes annonces », changez votre mot de passe et écrivez-nous sans attendre.",
    },
  },
  ar: {
    subject: {
      changed: "رابط دفع جديد لمتجرك",
      removed: "تمت إزالة رابط الدفع من متجرك",
      contact: "تم تعديل معلومات البائع",
      suspended: "تم تعليق زر «الدفع لدى البائع»",
      restored: "عاد زر «الدفع لدى البائع»",
      rejected: "تم رفض رابط الدفع",
    },
    body: (data, at) => {
      const shop = `«${data.shopName}»`;
      switch (data.kind) {
        case "changed":
          return [
            `تم تسجيل رابط دفع جديد نحو ${data.host} لمتجر ${shop}.`,
            at ? `سيحل محل الرابط الحالي في ${at}. حتى ذلك الحين لا يتغير شيء بالنسبة لمشتريك.` : `موقع الدفع هذا لم يتحقق منه ${SITE_NAME} بعد: سيُفعَّل الرابط بعد التحقق، بعد 24 ساعة على الأقل من تسجيله.`,
          ];
        case "removed":
          return [`تمت إزالة رابط الدفع لمتجر ${shop}. لم يعد زر «الدفع لدى البائع» يظهر على إعلاناتك.`];
        case "contact":
          return [`تم تعديل العنوان أو البريد الإلكتروني الذي يعرضه متجر ${shop} لمشتريه.`];
        case "suspended":
          return [`علّق فريق الإشراف زر «الدفع لدى البائع» لمتجر ${shop}.`, `السبب: ${data.reason ?? ""}`, "تبقى إعلاناتك منشورة. ردّ على هذا البريد للنقاش."];
        case "restored":
          return [`عاد زر «الدفع لدى البائع» لمتجر ${shop} للظهور.`];
        case "rejected":
          return [`لم يُقبل رابط الدفع نحو ${data.host} لمتجر ${shop}.`, `السبب: ${data.reason ?? ""}`, "أدخل صفحة الدفع الخاصة ببنكك أو بمزوّد دفع معتمد."];
      }
    },
    button: "إدارة الدفع في متجري",
    notYou: "إذا لم تكن أنت من قام بهذا التغيير، فأزل الرابط من فضائك المهني، وغيّر كلمة المرور، وراسلنا فورًا.",
    listing: {
      subject: { changed: "رابط دفع جديد لإعلان", removed: "تمت إزالة رابط الدفع من إعلان" },
      body: (kind, title, host, at) =>
        kind === "changed"
          ? [`تم تسجيل رابط دفع نحو ${host} لإعلانك «${title}».`, `سيفتحه زر «الدفع لدى البائع» لهذا الإعلان ابتداءً من ${at}. حتى ذلك الحين لا يتغير شيء بالنسبة لمشتريك.`]
          : [`تمت إزالة رابط الدفع الخاص بإعلانك «${title}». يفتح زر «الدفع لدى البائع» من جديد رابط متجرك إن وُجد.`],
      button: "عرض إعلاناتي",
      notYou: "إذا لم تكن أنت من قام بهذا التغيير، فأزل الرابط من «إعلاناتي»، وغيّر كلمة المرور، وراسلنا فورًا.",
    },
  },
};

export function sellerPaymentNotice(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const at = data.activeFrom ? formatDate(data.activeFrom, ctx.locale) : null;
  if (data.listingTitle !== undefined && (data.kind === "changed" || data.kind === "removed")) {
    const subject = copy.listing.subject[data.kind];
    return renderLayout({
      lang: ctx.lang,
      siteUrl: ctx.siteUrl,
      subject,
      title: subject,
      greeting: GREETING[ctx.lang](data.displayName),
      paragraphs: copy.listing.body(data.kind, data.listingTitle, data.host ?? "", at ?? ""),
      action: { label: copy.listing.button, url: pageUrl(ctx, "mes-annonces") },
      closing: [copy.listing.notYou],
    });
  }
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject[data.kind],
    title: copy.subject[data.kind],
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(data, at),
    action: { label: copy.button, url: pageUrl(ctx, "pro/paiement") },
    closing: data.kind === "changed" || data.kind === "removed" ? [copy.notYou] : [],
  });
}
