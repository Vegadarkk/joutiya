import { useSyncExternalStore } from "react";
import { ApiError, apiDelete, apiGet, csrfToken, type ApiErrorCode } from "@/lib/auth/client";
import { SEARCH_API, type FavoriteView, type FavoritesPage } from "@/lib/contracts/search";
import { CSRF_HEADER } from "@/lib/security/cookies";

// Browser side of the favorites (design D17): one module store of the favorite ids, fetched once
// per page load for the signed-in account (GET /api/favorites/ids) and shared by every heart of the
// page; toggles are optimistic and rolled back when the API refuses.

export interface FavoritesState {
  /** idle: never asked; loading; ready: `ids` is the account's list; failed: shown neutral, retried on use. */
  status: "idle" | "loading" | "ready" | "failed";
  /** Account the ids belong to. */
  uid: string | null;
  ids: ReadonlySet<string>;
  /** Listings with a request in flight (their heart ignores clicks). */
  busy: ReadonlySet<string>;
}

const INITIAL: FavoritesState = { status: "idle", uid: null, ids: new Set(), busy: new Set() };
let state: FavoritesState = INITIAL;
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(next: FavoritesState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The shared store (server render and hydration: idle, so every heart starts neutral). */
export function useFavorites(): FavoritesState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
}

export function favoritesSnapshot(): FavoritesState {
  return state;
}

/** Loads the ids of `uid` once (again after a failure or another account signed in). */
export function loadFavoriteIds(uid: string): Promise<void> {
  if (state.uid === uid && state.status === "ready") return Promise.resolve();
  if (state.uid === uid && inflight) return inflight;
  emit({ status: "loading", uid, ids: new Set(), busy: new Set() });
  const run = (async () => {
    try {
      const { ids } = await apiGet<{ ids: string[] }>(SEARCH_API.favoriteIds);
      if (state.uid === uid) emit({ ...state, status: "ready", ids: new Set(ids) });
    } catch {
      if (state.uid === uid) emit({ ...state, status: "failed" });
    } finally {
      if (inflight === run) inflight = undefined;
    }
  })();
  inflight = run;
  return run;
}

/** Signed out (or another account): every heart goes back to neutral. */
export function forgetFavorites(): void {
  inflight = undefined;
  if (state !== INITIAL) emit(INITIAL);
}

function withId(set: ReadonlySet<string>, id: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

async function errorOf(response: Response): Promise<ApiError> {
  let code: ApiErrorCode = response.status === 401 ? "unauthenticated" : response.status === 429 ? "rate_limited" : "internal";
  let details: unknown;
  try {
    const body = (await response.json()) as { error?: { code?: string; details?: unknown } };
    if (body.error?.code) code = body.error.code as ApiErrorCode;
    details = body.error?.details;
  } catch {
    // Not a JSON error body: the status decides.
  }
  const retry = Number(response.headers.get("Retry-After"));
  return new ApiError(response.status, code, { details, ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}) });
}

/** PUT /api/favorites/{id} (the shared client has no PUT helper): same headers as its mutations. */
export async function putFavorite(listingId: string): Promise<FavoriteView> {
  const headers: Record<string, string> = { accept: "application/json" };
  const csrf = csrfToken();
  if (csrf) headers[CSRF_HEADER] = csrf;
  let response: Response;
  try {
    response = await fetch(SEARCH_API.favorite(listingId), { method: "PUT", credentials: "same-origin", cache: "no-store", headers });
  } catch {
    throw new ApiError(0, "network");
  }
  if (!response.ok) throw await errorOf(response);
  return ((await response.json()) as { favorite: FavoriteView }).favorite;
}

export function deleteFavorite(listingId: string): Promise<void> {
  return apiDelete(SEARCH_API.favorite(listingId));
}

export function listFavorites(cursor?: string): Promise<FavoritesPage> {
  return apiGet<FavoritesPage>(cursor ? `${SEARCH_API.favorites}?cursor=${encodeURIComponent(cursor)}` : SEARCH_API.favorites);
}

/**
 * Adds or removes a favorite: the hearts change at once, the API confirms (or the change is undone
 * and the error rethrown for a toast). A heart with a request in flight ignores further clicks.
 */
export async function setFavorite(listingId: string, favorite: boolean): Promise<void> {
  if (state.busy.has(listingId)) return;
  const before = state.ids.has(listingId);
  emit({ ...state, ids: withId(state.ids, listingId, favorite), busy: withId(state.busy, listingId, true) });
  try {
    if (favorite) await putFavorite(listingId);
    else await deleteFavorite(listingId);
  } catch (error) {
    emit({ ...state, ids: withId(state.ids, listingId, before) });
    throw error;
  } finally {
    emit({ ...state, busy: withId(state.busy, listingId, false) });
  }
}
