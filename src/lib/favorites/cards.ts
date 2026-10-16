import type { FavoriteView } from "@/lib/contracts/search";
import type { FavoriteSnapshot } from "@/lib/db/schemas";
import type { SearchCard } from "@/lib/search/types";

// Favorites (design D17): the card a favorite shows. While the listing is in the search index the
// card is the live one; once it left (sold, expired, paused, removed) the snapshot saved with the
// favorite stands in, greyed by the page. Pure helpers, plus the opaque page cursor.

/** What a favorite keeps of the card it was added from. */
export function snapshotOf(card: SearchCard): FavoriteSnapshot {
  return {
    slugId: card.slugId,
    title: card.title,
    subcategoryId: card.subcategoryId,
    price: card.price,
    priceNegotiable: card.priceNegotiable,
    isDonation: card.isDonation,
    citySlug: card.citySlug,
    photo: card.photo,
    photoCount: card.photoCount,
    sellerType: card.sellerType,
  };
}

/** The saved snapshot as a card (no live date: the favorite's own date stands in). */
export function snapshotCard(listingId: string, snapshot: FavoriteSnapshot, createdAt: Date): SearchCard {
  return { id: listingId, ...snapshot, sortAt: createdAt.toISOString(), bumped: false, featured: false };
}

export function favoriteView(listingId: string, createdAt: Date, snapshot: FavoriteSnapshot, live: SearchCard | undefined, available = live !== undefined): FavoriteView {
  return { listingId, createdAt: createdAt.toISOString(), card: live ?? snapshotCard(listingId, snapshot, createdAt), available };
}

/** Position after the last favorite of a page (createdAt desc, then listing id desc). */
export interface FavoriteCursor {
  at: Date;
  id: string;
}

const LISTING_ID = /^[a-hj-km-np-z2-9]{8}$/;

export function encodeFavoritesCursor(cursor: FavoriteCursor): string {
  return Buffer.from(`${cursor.at.getTime()}.${cursor.id}`, "utf8").toString("base64url");
}

/** null for anything this server did not produce. */
export function decodeFavoritesCursor(value: string): FavoriteCursor | null {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(value)) return null;
  const [ms, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split(".");
  if (rest.length || !ms || !id || !/^\d{1,15}$/.test(ms) || !LISTING_ID.test(id)) return null;
  const at = new Date(Number(ms));
  return Number.isNaN(at.getTime()) ? null : { at, id };
}
