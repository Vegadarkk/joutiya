import "server-only";
import { FAVORITES_MAX, FAVORITES_PAGE_SIZE, type FavoriteView, type FavoritesPage } from "@/lib/contracts/search";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { toSearchCard } from "@/lib/search/cards";
import { searchEngine } from "@/lib/search/engine";
import { SearchUnavailableError, type SearchCard } from "@/lib/search/types";
import { decodeFavoritesCursor, encodeFavoritesCursor, favoriteView, snapshotOf } from "./cards";
import { bumpFavoriteStat, cachedFavoriteIds, recordFavoriteChange } from "./ids-cache";
import { createFavorite, deleteFavorite, getFavorite, listFavoriteIds, listFavoritesPage, type FavoriteRecord } from "./repository";

// Favorites (design D17). Adding needs the listing in the search index: its card comes from the
// engine (0 Firestore read) and becomes the snapshot shown once the listing is gone. The cap
// (FAVORITES_MAX) is checked on the hearts cache; going one or two over under a race is harmless.

/** Rebuild bound of the hearts cache: the cap, with room for a race or an older, larger list. */
const IDS_READ_LIMIT = FAVORITES_MAX * 2;

export const searchUnavailable = () => new HttpError(503, "search_unavailable", undefined, { headers: { "Retry-After": "30" } });

/** Cards of the listings still in the index, by id (engine lookup `id IN [...]`). */
export async function liveCards(ids: readonly string[], now = new Date()): Promise<Map<string, SearchCard>> {
  const cards = new Map<string, SearchCard>();
  if (ids.length === 0) return cards;
  const [result] = await searchEngine().search([{ q: "", filter: { field: "id", op: "in", values: [...ids] }, page: 1, hitsPerPage: ids.length }]);
  for (const hit of result?.hits ?? []) cards.set(hit.id, toSearchCard(hit, now));
  return cards;
}

/** Favorite listing ids of the account (hearts): Valkey set, rebuilt from Firestore on a miss. */
export function favoriteIdsOf(uid: string): Promise<string[]> {
  return cachedFavoriteIds(uid, () => listFavoriteIds(uid, IDS_READ_LIMIT));
}

async function liveCard(listingId: string, now: Date): Promise<SearchCard | undefined> {
  try {
    return (await liveCards([listingId], now)).get(listingId);
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw searchUnavailable();
    throw error;
  }
}

async function existingView(record: FavoriteRecord, now: Date): Promise<FavoriteView> {
  return favoriteView(record.listingId, record.createdAt, record.listingSnapshot, await liveCard(record.listingId, now));
}

/** Adds `listingId` to the favorites of `uid`; `created` is false when it already was one. */
export async function addFavorite(uid: string, listingId: string, now = new Date()): Promise<{ created: boolean; favorite: FavoriteView }> {
  const ids = await favoriteIdsOf(uid);
  if (ids.includes(listingId)) {
    const existing = await getFavorite(uid, listingId);
    if (existing) return { created: false, favorite: await existingView(existing, now) };
  }
  if (ids.length >= FAVORITES_MAX) throw new HttpError(409, "favorite_limit");
  const card = await liveCard(listingId, now);
  if (!card) throw new HttpError(409, "listing_unavailable");
  const created = await createFavorite(uid, listingId, { createdAt: now, listingSnapshot: snapshotOf(card) });
  if (!created) {
    // A parallel add won: answer with what it stored.
    const existing = await getFavorite(uid, listingId);
    await recordFavoriteChange(uid, listingId, "add");
    return { created: false, favorite: favoriteView(listingId, existing?.createdAt ?? now, existing?.listingSnapshot ?? snapshotOf(card), card) };
  }
  await recordFavoriteChange(uid, listingId, "add");
  await bumpFavoriteStat(listingId, 1);
  return { created: true, favorite: favoriteView(listingId, now, snapshotOf(card), card) };
}

export async function removeFavorite(uid: string, listingId: string): Promise<void> {
  const deleted = await deleteFavorite(uid, listingId);
  await recordFavoriteChange(uid, listingId, "remove");
  if (deleted) await bumpFavoriteStat(listingId, -1);
}

/**
 * One page of the favorites, newest first: the live card while the listing is indexed, else the
 * snapshot marked unavailable. With the engine down the snapshots are shown as they were saved
 * (the listing page itself tells the current state).
 */
export async function favoritesPage(uid: string, cursorValue: string | undefined, now = new Date()): Promise<FavoritesPage> {
  const cursor = cursorValue ? decodeFavoritesCursor(cursorValue) : undefined;
  if (cursor === null) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "cursor", code: "invalid_value" }] });
  const [page, ids] = await Promise.all([listFavoritesPage(uid, FAVORITES_PAGE_SIZE, cursor), favoriteIdsOf(uid)]);
  let live: Map<string, SearchCard> | null;
  try {
    live = await liveCards(page.favorites.map((favorite) => favorite.listingId), now);
  } catch (error) {
    if (!(error instanceof SearchUnavailableError)) throw error;
    logger.warn({ err: error.message }, "favorites page without the search engine");
    live = null;
  }
  return {
    favorites: page.favorites.map((favorite) => {
      const card = live?.get(favorite.listingId);
      return favoriteView(favorite.listingId, favorite.createdAt, favorite.listingSnapshot, card, live === null || card !== undefined);
    }),
    ...(page.next ? { next: encodeFavoritesCursor(page.next) } : {}),
    total: Math.max(ids.length, page.favorites.length),
  };
}
