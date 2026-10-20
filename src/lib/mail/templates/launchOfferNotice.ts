import type { TemplateData } from "../types";
import { formatDay, GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// End of the launch offer (phase 7 design D3): the notices before `endsAt` (J-30, J-7, J-1 with
// `noticeDays` 30) and the mail of the downgrade, sent by the nightly pro-plans job. Without a plan
// the account stays Pro; the listings over the free quota are paused (never deleted) and the
// storefront is hidden until a plan is chosen.

type Data = TemplateData["launchOfferNotice"];

interface Copy {
  subject: (plan: string, day: string, ended: boolean) => string;
  title: (ended: boolean) => string;
  ending: (plan: string, shop: string, day: string) => string[];
  without: (freeListings: number | null) => string;
  ended: (plan: string, shop: string, day: string) => string;
  paused: (count: number) => string;
  storefront: string;
  button: string;
  closing: string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subject: (plan, day, ended) => (ended ? `Votre offre ${plan} offerte est terminée` : `Votre offre ${plan} offerte se termine le ${day}`),
    title: (ended) => (ended ? "Offre de lancement terminée" : "Fin de l'offre de lancement"),
    ending: (plan, shop, day) => [
      `L'offre ${plan} offerte à « ${shop} » se termine le ${day}.`,
      "Pour garder vos annonces en ligne, votre vitrine et les crédits de l'offre chaque mois, choisissez une offre avant cette date depuis votre espace Pro. Le paiement se fait sur la page sécurisée de Stripe.",
    ],
    without: (free) =>
      free === null
        ? "Sans abonnement, votre compte reste Pro, mais votre vitrine n'est plus visible."
        : free === 0
          ? "Sans abonnement, votre compte reste Pro, mais vos annonces en ligne sont mises en pause, sans être supprimées, et votre vitrine n'est plus visible."
          : `Sans abonnement, votre compte reste Pro, mais vos annonces au-delà de ${free} sont mises en pause, les plus anciennes d'abord, sans être supprimées, et votre vitrine n'est plus visible.`,
    ended: (plan, shop, day) => `L'offre ${plan} offerte à « ${shop} » s'est terminée le ${day}. Votre compte reste un compte Pro.`,
    paused: (count) =>
      count === 1
        ? "1 annonce a été mise en pause. Elle n'est pas supprimée : remettez-la en ligne depuis Mes annonces après avoir choisi une offre."
        : `${count} annonces ont été mises en pause. Elles ne sont pas supprimées : remettez-les en ligne depuis Mes annonces après avoir choisi une offre.`,
    storefront: "Votre vitrine n'est plus visible. Choisissez une offre pour la retrouver et recevoir les crédits de l'offre chaque mois.",
    button: "Choisir mon offre",
    closing: "Pour payer, passez toujours par votre espace Pro sur Joutiya : nous ne vous demanderons jamais de paiement par message.",
  },
  ar: {
    subject: (plan, day, ended) => (ended ? `انتهت باقة ${plan} المجانية` : `تنتهي باقة ${plan} المجانية في ${day}`),
    title: (ended) => (ended ? "انتهى عرض الإطلاق" : "نهاية عرض الإطلاق"),
    ending: (plan, shop, day) => [
      `تنتهي باقة ${plan} المجانية لمتجر «${shop}» في ${day}.`,
      "للإبقاء على إعلاناتك منشورة وعلى واجهة متجرك ونقاط الباقة كل شهر، اختر باقة قبل هذا التاريخ من فضائك المهني. يتم الدفع على صفحة Stripe الآمنة.",
    ],
    without: (free) =>
      free === null
        ? "بدون اشتراك يبقى حسابك مهنيًا، لكن واجهة متجرك لا تعود ظاهرة."
        : free === 0
          ? "بدون اشتراك يبقى حسابك مهنيًا، لكن إعلاناتك المنشورة تُوقف مؤقتًا دون حذفها، ولا تعود واجهة متجرك ظاهرة."
          : `بدون اشتراك يبقى حسابك مهنيًا، لكن الإعلانات التي تتجاوز الحصة المجانية (${free}) تُوقف مؤقتًا دون حذفها، بدءًا بالأقدم، ولا تعود واجهة متجرك ظاهرة.`,
    ended: (plan, shop, day) => `انتهت باقة ${plan} المجانية لمتجر «${shop}» في ${day}. يبقى حسابك حسابًا مهنيًا.`,
    paused: (count) =>
      count === 1
        ? "أُوقف إعلان واحد مؤقتًا دون حذفه: أعد نشره من «إعلاناتي» بعد اختيار باقة."
        : `عدد الإعلانات الموقوفة مؤقتًا: ${count}. لم تُحذف: أعد نشرها من «إعلاناتي» بعد اختيار باقة.`,
    storefront: "لم تعد واجهة متجرك ظاهرة. اختر باقة لاستعادتها والحصول على نقاط الباقة كل شهر.",
    button: "اختيار باقتي",
    closing: "للدفع، مرّ دائمًا عبر فضائك المهني على جوطية: لن نطلب منك أي دفع عبر الرسائل.",
  },
};

const PLAN_NAMES: Record<Data["plan"], string> = { essentiel: "Essentiel", business: "Business" };

export function launchOfferNotice(data: Data, ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const plan = PLAN_NAMES[data.plan];
  const day = formatDay(data.endsAt, ctx.locale);
  const ended = data.kind === "ended";
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(plan, day, ended),
    title: copy.title(ended),
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: ended
      ? [copy.ended(plan, data.shopName, day), ...(data.paused > 0 ? [copy.paused(data.paused)] : []), copy.storefront]
      : [...copy.ending(plan, data.shopName, day), copy.without(data.freeListings)],
    action: { label: copy.button, url: pageUrl(ctx, "pro/abonnement") },
    closing: [copy.closing],
  });
}
