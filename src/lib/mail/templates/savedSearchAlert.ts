import { cityBySlug, cityName } from "@/config/regions";
import { formatPrice } from "@/lib/listings/client/format";
import type { FavoriteDropListing, SavedSearchAlertListing, SavedSearchAlertSection, TemplateData } from "../types";
import { GREETING, pageUrl, renderLayout, type BuiltMail, type MailLocale, type MailSection, type TemplateContext } from "./layout";

// Saved-search alert digest (design D19, bulk priority): one e-mail a day at most, one block per
// search with new listings (the newest few, then the link to all of them). No photo (no remote
// image in mails). D20: List-Unsubscribe (RFC 2369) to the one-click API + List-Unsubscribe-Post
// (RFC 8058), and the "Se désabonner" link to the confirm page; both carry the account token.
// Catalogue §4: favorites whose promotion started since the last run come first, in the same
// e-mail (no new one), with the promotional price and the struck-out one.

interface Copy {
  subjectOne: (name: string, total: number) => string;
  subjectMany: (total: number) => string;
  title: string;
  leadOne: string;
  leadMany: (searches: number) => string;
  count: (total: number) => string;
  zone: (km: number, city: string) => string;
  seeAll: (total: number) => string;
  seeSearch: string;
  donation: string;
  toDiscuss: string;
  detail: (price: string, city: string | null) => string;
  manage: string;
  unsubscribe: string;
  closing: string;
  subjectFavorites: (count: number) => string;
  favoritesHeading: string;
  favoritesLead: string;
  seeFavorites: string;
  kinds: Record<FavoriteDropListing["kind"], string>;
  drop: (price: string, before: string | null, badge: string, city: string | null) => string;
}

const COPY: Record<MailLocale, Copy> = {
  fr: {
    subjectOne: (name, total) => `${total === 1 ? "1 nouvelle annonce" : `${total} nouvelles annonces`} pour « ${name} »`,
    subjectMany: (total) => `${total} nouvelles annonces pour vos recherches`,
    title: "Du nouveau pour vos recherches",
    leadOne: "Depuis notre dernier e-mail, de nouvelles annonces correspondent à votre recherche sauvegardée.",
    leadMany: (searches) => `Depuis notre dernier e-mail, de nouvelles annonces correspondent à ${searches} de vos recherches sauvegardées.`,
    count: (total) => (total === 1 ? "1 nouvelle annonce" : `${total} nouvelles annonces`),
    zone: (km, city) => `Zone de la carte · ${km} km autour de ${city}`,
    seeAll: (total) => `Voir les ${total} annonces`,
    seeSearch: "Voir la recherche",
    donation: "Don",
    toDiscuss: "Prix à discuter",
    detail: (price, city) => (city ? `${price}, ${city}` : price),
    manage: "Gérer mes alertes :",
    unsubscribe: "Ne plus recevoir ces alertes :",
    closing: "Vous recevez cet e-mail parce que vous avez activé une alerte sur une recherche sauvegardée. Un e-mail par jour au plus, seulement quand il y a du nouveau.",
    subjectFavorites: (count) => (count === 1 ? "Un de vos favoris est en promotion" : `${count} de vos favoris sont en promotion`),
    favoritesHeading: "Vos favoris en promotion",
    favoritesLead: "Depuis notre dernier e-mail, des annonces de vos favoris sont passées en promotion.",
    seeFavorites: "Voir mes favoris",
    kinds: { promo: "Promo", soldes: "Soldes", flash: "Vente flash" },
    drop: (price, before, badge, city) => [before ? `${price} au lieu de ${before}` : price, badge, city].filter(Boolean).join(", "),
  },
  ar: {
    subjectOne: (name) => `إعلانات جديدة لبحثك «${name}»`,
    subjectMany: () => "إعلانات جديدة لعمليات البحث المحفوظة",
    title: "جديد عمليات البحث المحفوظة",
    leadOne: "منذ رسالتنا الأخيرة، نُشرت إعلانات جديدة تطابق بحثك المحفوظ.",
    leadMany: (searches) => `منذ رسالتنا الأخيرة، نُشرت إعلانات جديدة تطابق ${searches} من عمليات البحث المحفوظة.`,
    count: (total) => `عدد الإعلانات الجديدة: ${total}`,
    zone: (km, city) => `منطقة الخريطة · ${km} كلم حول ${city}`,
    seeAll: (total) => `عرض كل الإعلانات (${total})`,
    seeSearch: "عرض نتائج البحث",
    donation: "مجانًا",
    toDiscuss: "السعر حسب الاتفاق",
    detail: (price, city) => (city ? `${price}، ${city}` : price),
    manage: "إدارة تنبيهاتي:",
    unsubscribe: "إيقاف هذه التنبيهات:",
    closing: "تتلقى هذا البريد لأنك فعّلت تنبيهًا على بحث محفوظ. رسالة واحدة في اليوم على الأكثر، وفقط عند وجود جديد.",
    subjectFavorites: (count) => (count === 1 ? "أحد إعلاناتك المفضلة عليه تخفيض" : `${count} من إعلاناتك المفضلة عليها تخفيض`),
    favoritesHeading: "مفضلاتك عليها تخفيض",
    favoritesLead: "منذ رسالتنا الأخيرة، أصبحت بعض إعلاناتك المفضلة بسعر مخفَّض.",
    seeFavorites: "عرض مفضلاتي",
    kinds: { promo: "تخفيض", soldes: "تخفيضات", flash: "عرض خاطف" },
    drop: (price, before, badge, city) => [before ? `${price} بدلاً من ${before}` : price, badge, city].filter(Boolean).join("، "),
  },
};

/** One-click endpoint of the List-Unsubscribe header (the token is URL-safe base64 plus a dot). */
export function unsubscribeApiUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/$/, "")}/api/alerts/unsubscribe?t=${encodeURIComponent(token)}`;
}

function detailOf(listing: SavedSearchAlertListing, copy: Copy, lang: MailLocale): string {
  const price = listing.isDonation ? copy.donation : listing.price === null ? copy.toDiscuss : formatPrice(listing.price, lang);
  const city = listing.citySlug ? cityBySlug(listing.citySlug) : undefined;
  return copy.detail(price, city ? cityName(city, lang) : null);
}

function sectionOf(search: SavedSearchAlertSection, copy: Copy, lang: MailLocale): MailSection {
  const zoneCity = search.zone ? cityBySlug(search.zone.citySlug) : undefined;
  return {
    heading: search.name,
    // A map zone says where it is: the name may be the visitor's own.
    note: search.zone && zoneCity ? `${copy.count(search.total)} — ${copy.zone(search.zone.km, cityName(zoneCity, lang))}` : copy.count(search.total),
    items: search.listings.map((listing) => ({ title: listing.title, detail: detailOf(listing, copy, lang), url: listing.url })),
    more: { label: search.total > search.listings.length ? copy.seeAll(search.total) : copy.seeSearch, url: search.url },
  };
}

function favoritesSection(favorites: FavoriteDropListing[], copy: Copy, ctx: TemplateContext): MailSection {
  const lang = ctx.lang;
  return {
    heading: copy.favoritesHeading,
    items: favorites.map((listing) => {
      const city = listing.citySlug ? cityBySlug(listing.citySlug) : undefined;
      const badge = listing.percent > 0 ? `${copy.kinds[listing.kind]} −${listing.percent} %` : copy.kinds[listing.kind];
      return { title: listing.title, detail: copy.drop(formatPrice(listing.price ?? 0, lang), listing.before === null ? null : formatPrice(listing.before, lang), badge, city ? cityName(city, lang) : null), url: listing.url };
    }),
    more: { label: copy.seeFavorites, url: pageUrl(ctx, "favoris") },
  };
}

export function savedSearchAlert(data: TemplateData["savedSearchAlert"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  const total = data.searches.reduce((sum, search) => sum + search.total, 0);
  const only = data.searches.length === 1 ? data.searches[0] : undefined;
  const favorites = data.favorites ?? [];
  const built = renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: data.searches.length === 0 ? copy.subjectFavorites(favorites.length) : only ? copy.subjectOne(only.name, only.total) : copy.subjectMany(total),
    title: data.searches.length === 0 ? copy.favoritesHeading : copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [...(favorites.length > 0 ? [copy.favoritesLead] : []), ...(data.searches.length > 0 ? [only ? copy.leadOne : copy.leadMany(data.searches.length)] : [])],
    sections: [...(favorites.length > 0 ? [favoritesSection(favorites, copy, ctx)] : []), ...data.searches.map((search) => sectionOf(search, copy, ctx.lang))],
    links: [
      { label: copy.manage, url: pageUrl(ctx, "recherches") },
      { label: copy.unsubscribe, url: pageUrl(ctx, `alertes/desabonnement?t=${encodeURIComponent(data.unsubscribeToken)}`) },
    ],
    closing: [copy.closing],
  });
  return {
    ...built,
    headers: { "List-Unsubscribe": `<${unsubscribeApiUrl(ctx.siteUrl, data.unsubscribeToken)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
