import { blurhashPlaceholder, photoSources } from "@/components/listing/photo";
import { formatCardDate } from "@/components/listing/listing-card";
import { subcategoryById } from "@/config/categories";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { formatPrice, groupDigits, intlLocale } from "@/lib/listings/client/format";
import { isPublishedToday, pinSources, type LatLng } from "@/lib/search/map-pins";
import type { SearchCard } from "@/lib/search/types";

// The results of a page as the map island sees them (Carte vivante, lot 2): every string already
// formatted on the server, so the browser needs neither the category tree nor the formatters. Only
// what the results card already shows (search card fields), at the pin's approximate position.

export interface MapListing {
  id: string;
  slugId: string;
  title: string;
  /** "1 500 DH", "Don", "Prix à discuter". */
  amount: string;
  /** "par mois" for a rent. */
  per?: string;
  negotiable: boolean;
  /** Short pin text: "1 500", "4 500/mois", "1,2 M". */
  pin: string;
  place: string | null;
  date: string;
  /** ISO 8601. */
  dateTime: string;
  today: boolean;
  /** Served in an À la Une slot of this page (§8 mention). */
  featured: boolean;
  bumped: boolean;
  position: LatLng;
  photo: { src: string; srcSet: string; width: number; height: number; placeholder: string | null } | null;
  photoCount: number;
  /** Key numbers of the card ("85 m²", "3 pièces"). */
  facts: string[];
  pro: boolean;
  exclusive: boolean;
  example: boolean;
  /** A job seeker's ad (« Demandes d'emploi »): off the map by default, a filter brings it back. */
  jobSeeker: boolean;
}

/** The subcategory of job seekers' ads (job, internship, work-study requests). */
export const JOB_SEEKER_SUBCATEGORY = "demandes-emploi";

export interface MapListingLabels {
  donation: string;
  toDiscuss: string;
  /** A job offer without an amount (« Salaire à convenir »); `toDiscuss` when absent. */
  salaryToDiscuss?: string;
  today: string;
  per: (unit: "night" | "month" | "day") => string;
  pinPer: (unit: "night" | "month" | "day") => string;
  fact: (id: string, count: number) => string | null;
}

/** Short price of a pin: grouped digits under a million, compact above ("1,2 M"). */
export function pinAmount(price: number, locale: Locale): string {
  if (price < 1_000_000) return groupDigits(String(Math.max(0, Math.trunc(price)))) || "0";
  return new Intl.NumberFormat(intlLocale(locale), { notation: "compact", maximumFractionDigits: 1 }).format(price);
}

export function buildMapListings(input: { featured: readonly SearchCard[]; hits: readonly SearchCard[]; locale: Locale; media: string | null; now: Date; labels: MapListingLabels }): MapListing[] {
  const { featured, hits, locale, media, now, labels } = input;
  const cards = new Map([...hits, ...featured].map((card) => [card.id, card]));
  return pinSources(featured, hits).flatMap(({ id, position, featured: isFeatured }) => {
    const card = cards.get(id);
    if (!card) return [];
    const subcategory = card.subcategoryId ? subcategoryById(card.subcategoryId) : undefined;
    const unit = subcategory?.priceUnit;
    const priced = !card.isDonation && card.price !== null;
    const city = card.citySlug ? cityBySlug(card.citySlug) : undefined;
    const sources = card.photo ? photoSources(media, card.id, card.photo, "s") : null;
    const today = isPublishedToday(card, now);
    // A job-seeker ad carries no amount: a dash on the pin and the row. A job offer without one
    // says « Salaire à convenir ».
    const unpriced = subcategory?.priceMode === "none" ? "—" : subcategory?.priceMode === "salary" ? (labels.salaryToDiscuss ?? labels.toDiscuss) : labels.toDiscuss;
    const amount = card.isDonation ? labels.donation : card.price === null ? unpriced : formatPrice(card.price, locale);
    const pin = card.isDonation ? labels.donation : card.price === null ? unpriced : `${pinAmount(card.price, locale)}${unit ? labels.pinPer(unit) : ""}`;
    const listing: MapListing = {
      id: card.id,
      slugId: card.slugId,
      title: card.title,
      amount,
      ...(priced && unit ? { per: labels.per(unit) } : {}),
      negotiable: priced && card.priceNegotiable,
      pin,
      place: city ? cityName(city, locale) : null,
      date: today ? labels.today : formatCardDate(card.sortAt, locale),
      dateTime: card.sortAt,
      today,
      featured: isFeatured,
      bumped: card.bumped,
      position,
      photo: sources ? { src: sources.src, srcSet: sources.srcSet, width: sources.width, height: sources.height, placeholder: blurhashPlaceholder(card.photo?.blurhash) } : null,
      photoCount: card.photoCount,
      facts: (card.facts?.facts ?? []).flatMap((fact) => labels.fact(fact.id, fact.value) ?? []),
      pro: card.sellerType === "pro",
      exclusive: card.facts?.exclusive === true,
      example: card.example === true,
      jobSeeker: card.subcategoryId === JOB_SEEKER_SUBCATEGORY,
    };
    return [listing];
  });
}
