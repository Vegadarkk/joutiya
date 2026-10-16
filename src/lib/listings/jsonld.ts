import type { Condition } from "@/config/categories";
import type { PublicListing, PublicState } from "./public";

// schema.org Product + Offer of a public listing page (design §5). Pure. What the page shows and
// nothing more: no phone, no seller identity (a neutral host page about the item), city-level place
// only. Serialized into a `<script type="application/ld+json">` data block, which the hash CSP does
// not govern (inline-hashes.ts skips non-JS types); `serializeJsonLd` keeps it from ever closing the
// script element.

const AVAILABILITY: Record<PublicState, string> = {
  published: "https://schema.org/InStock",
  paused: "https://schema.org/OutOfStock",
  sold: "https://schema.org/SoldOut",
  expired: "https://schema.org/Discontinued",
};

const ITEM_CONDITION: Record<Condition, string> = {
  new_tagged: "https://schema.org/NewCondition",
  like_new: "https://schema.org/UsedCondition",
  very_good: "https://schema.org/UsedCondition",
  good: "https://schema.org/UsedCondition",
  for_parts: "https://schema.org/DamagedCondition",
};

/** Google truncates long descriptions anyway; keeps the HTML small. */
export const JSON_LD_DESCRIPTION_MAX = 1000;

export interface ListingJsonLdInput {
  listing: PublicListing;
  /** Absolute canonical URL of the page. */
  url: string;
  /** Absolute URLs of the `l` variants, in display order. */
  images: string[];
  /** Localized names. */
  categoryName?: string;
  cityName?: string;
  regionName?: string;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function listingJsonLd({ listing, url, images, categoryName, cityName, regionName }: ListingJsonLdInput): Record<string, unknown> {
  const place = cityName
    ? {
        "@type": "Place",
        address: { "@type": "PostalAddress", addressLocality: cityName, ...(regionName ? { addressRegion: regionName } : {}), addressCountry: "MA" },
      }
    : undefined;
  // "À discuter" has no amount: an Offer without a price would be invalid, so none is published.
  const price = listing.isDonation ? 0 : listing.price;
  const offer =
    price === null
      ? undefined
      : {
          "@type": "Offer",
          url,
          price: String(price),
          priceCurrency: "MAD",
          availability: AVAILABILITY[listing.state],
          ...(listing.condition ? { itemCondition: ITEM_CONDITION[listing.condition] } : {}),
          ...(place ? { availableAtOrFrom: place } : {}),
        };
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
    name: listing.title,
    description: truncate(listing.description, JSON_LD_DESCRIPTION_MAX),
    sku: listing.id,
    url,
    ...(images.length > 0 ? { image: images } : {}),
    ...(categoryName ? { category: categoryName } : {}),
    ...(offer ? { offers: offer } : {}),
  };
}

/**
 * JSON for an inline data block: `<`, `>` and `&` as \u escapes (no `</script>`, no comment or CDATA
 * opener can appear), and the two line separators JSON allows but some parsers do not.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
