import { z } from "@/lib/zod";
import { listingIdSchema } from "./listings";
import type { SearchParams } from "@/lib/search/params";
import { storedSearchParamsSchema } from "@/lib/search/params";
import type { SearchCard, SearchResponse } from "@/lib/search/types";

// Client-safe contracts of phase 4 (design §3): search API, favorites, saved searches and alerts.

/** Favorites per account (not set by §5; bounded so the hearts cache and the page stay small). */
export const FAVORITES_MAX = 300;
/** §5: 10 saved searches at most. */
export const SAVED_SEARCHES_MAX = 10;
export const SAVED_SEARCH_NAME_MAX = 60;
export const SAVED_SEARCH_ALERTS = ["none", "daily"] as const;
export type SavedSearchAlert = (typeof SAVED_SEARCH_ALERTS)[number];
/** Favorites page size (cursor pagination, Firestore reads stay bounded). */
export const FAVORITES_PAGE_SIZE = 48;
/** Header carrying a solved Turnstile token on GET /api/search (no body on a GET). */
export const TURNSTILE_HEADER = "x-turnstile-token";

export const SEARCH_API = {
  /** GET ?<search params> -> SearchApiResponse. Over the limits: 403 turnstile_required, then 429. */
  search: "/api/search",
  /** GET -> { ids: string[] } (hearts state; Valkey cache over the subcollection). */
  favoriteIds: "/api/favorites/ids",
  /** GET ?cursor= -> FavoritesPage. */
  favorites: "/api/favorites",
  /** PUT -> 201/200 { favorite } ; DELETE -> 204. */
  favorite: (listingId: string) => `/api/favorites/${listingId}`,
  /** GET -> { searches: SavedSearchView[] } ; POST SavedSearchCreate -> 201 { search }. */
  savedSearches: "/api/saved-searches",
  /** PATCH SavedSearchPatch -> { search } ; DELETE -> 204. */
  savedSearch: (id: string) => `/api/saved-searches/${id}`,
  /** POST { token } (and RFC 8058 one-click POST with ?t=) -> 204. No session, no CSRF: the token authenticates. */
  unsubscribe: "/api/alerts/unsubscribe",
  /** POST { token } -> 204 + __Host-tsv pass (page challenge of /anti-robot). */
  challengePass: "/api/challenge/pass",
} as const;

export type SearchApiResponse = SearchResponse;

export interface FavoriteView {
  listingId: string;
  /** ISO 8601. */
  createdAt: string;
  /** Live card while the listing is searchable, else the saved snapshot. */
  card: SearchCard;
  /** False once the listing left the index (sold, expired, paused, removed). */
  available: boolean;
}

export interface FavoritesPage {
  favorites: FavoriteView[];
  /** Opaque; absent on the last page. */
  next?: string;
  total: number;
}

export const savedSearchIdSchema = z.string().regex(/^[A-Za-z0-9]{20}$/);
export const favoriteListingIdSchema = listingIdSchema;

export const savedSearchCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(SAVED_SEARCH_NAME_MAX).optional(),
    params: storedSearchParamsSchema,
    alert: z.enum(SAVED_SEARCH_ALERTS).default("daily"),
  })
  .strict();
export type SavedSearchCreate = z.input<typeof savedSearchCreateSchema>;

export const savedSearchPatchSchema = z
  .object({ name: z.string().trim().min(1).max(SAVED_SEARCH_NAME_MAX).optional(), alert: z.enum(SAVED_SEARCH_ALERTS).optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.alert !== undefined, { message: "empty patch" });
export type SavedSearchPatch = z.infer<typeof savedSearchPatchSchema>;

export interface SavedSearchView {
  id: string;
  name: string;
  params: SearchParams;
  alert: SavedSearchAlert;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 of the last alert e-mail, if any. */
  lastAlertAt?: string;
}

export const unsubscribeSchema = z.object({ token: z.string().min(16).max(512) }).strict();
export const challengePassSchema = z.object({ token: z.string().min(1).max(2048) }).strict();
