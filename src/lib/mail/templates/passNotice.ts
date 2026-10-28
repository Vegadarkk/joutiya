import { SITE_NAME } from "@/config/site";
import type { TemplateData } from "../types";
import { formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// End of a Pass Boutique (owner decision 2026-10-28): the notices at J-7 and J-1 and the mail of
// the downgrade, sent by the nightly pro-plans job. The pass never renews: the shop buys another
// one or subscribes. Without either the account stays Pro, its listings over the free quota are
// paused (never deleted) and the storefront is hidden.

type Data = TemplateData["passNotice"];

interface Copy {
  subject: (day: string, ended: boolean) => string;
  title: (ended: boolean) => string;
  ending: (shop: string, day: string) => string[];
  without: (freeListings: number | null) => string;
  ended: (shop: string, day: string) => string;
  paused: (count: number) => string;
  storefront: string;
  button: string;
  closing: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (day, ended) => (ended ? "Votre Pass Boutique est terminé" : `Votre Pass Boutique se termine le ${day}`),
    title: (ended) => (ended ? "Pass Boutique terminé" : "Fin de votre Pass Boutique"),
    ending: (shop, day) => [
      `Le Pass Boutique de « ${shop} » se termine le ${day}. Il ne se renouvelle pas tout seul.`,
      "Pour garder votre boutique en ligne, prenez un nouveau pass ou un abonnement avant cette date depuis votre espace Pro. Les jours qui restent sur votre pass ne sont pas perdus : un nouveau pass commence à la fin de celui-ci, et un abonnement pris au moins 2 jours avant cette date n'est facturé qu'à cette date.",
    ],
    without: (free) =>
      free === null
        ? "Sans nouveau pass ni abonnement, votre compte reste Pro, mais votre boutique n'est plus visible."
        : free === 0
          ? "Sans nouveau pass ni abonnement, votre compte reste Pro, mais vos annonces en ligne sont mises en pause, sans être supprimées, et votre boutique n'est plus visible."
          : `Sans nouveau pass ni abonnement, votre compte reste Pro, mais vos annonces au-delà de ${free} sont mises en pause, les plus anciennes d'abord, sans être supprimées, et votre boutique n'est plus visible.`,
    ended: (shop, day) => `Le Pass Boutique de « ${shop} » s'est terminé le ${day}. Votre compte reste un compte Pro.`,
    paused: (count) =>
      count === 1
        ? "1 annonce a été mise en pause. Elle n'est pas supprimée : remettez-la en ligne depuis Mes annonces après avoir pris un pass ou une offre."
        : `${count} annonces ont été mises en pause. Elles ne sont pas supprimées : remettez-les en ligne depuis Mes annonces après avoir pris un pass ou une offre.`,
    storefront: "Votre boutique n'est plus visible. Un nouveau pass ou un abonnement la remet en ligne aussitôt.",
    button: "Prolonger ma boutique",
    closing: `Pour payer, passez toujours par votre espace Pro sur ${SITE_NAME} : nous ne vous demanderons jamais de paiement par message.`,
  },
  ar: {
    subject: (day, ended) => (ended ? "انتهى عرض المتجر المؤقت" : `ينتهي عرض المتجر المؤقت في ${day}`),
    title: (ended) => (ended ? "انتهى عرض المتجر المؤقت" : "نهاية عرض المتجر المؤقت"),
    ending: (shop, day) => [
      `ينتهي عرض المتجر المؤقت الخاص بـ«${shop}» في ${day}، ولا يتجدد تلقائيًا.`,
      "للإبقاء على متجرك منشورًا، خذ عرضًا مؤقتًا جديدًا أو اشتراكًا قبل هذا التاريخ من فضائك المهني. الأيام المتبقية لا تضيع: يبدأ العرض الجديد عند نهاية الحالي، والاشتراك المأخوذ قبل هذا التاريخ بيومين على الأقل لا يُفوتَر إلا فيه.",
    ],
    without: (free) =>
      free === null
        ? "بدون عرض جديد أو اشتراك يبقى حسابك مهنيًا، لكن متجرك لا يعود ظاهرًا."
        : free === 0
          ? "بدون عرض جديد أو اشتراك يبقى حسابك مهنيًا، لكن إعلاناتك المنشورة تُوقف مؤقتًا دون حذفها، ولا يعود متجرك ظاهرًا."
          : `بدون عرض جديد أو اشتراك يبقى حسابك مهنيًا، لكن الإعلانات التي تتجاوز الحصة المجانية (${free}) تُوقف مؤقتًا دون حذفها، بدءًا بالأقدم، ولا يعود متجرك ظاهرًا.`,
    ended: (shop, day) => `انتهى عرض المتجر المؤقت الخاص بـ«${shop}» في ${day}. يبقى حسابك حسابًا مهنيًا.`,
    paused: (count) =>
      count === 1
        ? "أُوقف إعلان واحد مؤقتًا دون حذفه: أعد نشره من «إعلاناتي» بعد أخذ عرض أو باقة."
        : `عدد الإعلانات الموقوفة مؤقتًا: ${count}. لم تُحذف: أعد نشرها من «إعلاناتي» بعد أخذ عرض أو باقة.`,
    storefront: "لم يعد متجرك ظاهرًا. عرض جديد أو اشتراك يعيده فورًا.",
    button: "تمديد متجري",
    closing: `للدفع، مرّ دائمًا عبر فضائك المهني على ${SITE_NAME}: لن نطلب منك أي دفع عبر الرسائل.`,
  },
};

export function passNotice(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const day = formatDay(data.endsAt, ctx.locale);
  const ended = data.kind === "ended";
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(day, ended),
    title: copy.title(ended),
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: ended
      ? [copy.ended(data.shopName, day), ...(data.paused > 0 ? [copy.paused(data.paused)] : []), copy.storefront]
      : [...copy.ending(data.shopName, day), copy.without(data.freeListings)],
    action: { label: copy.button, url: pageUrl(ctx, "pro/abonnement") },
    closing: [copy.closing],
  });
}
