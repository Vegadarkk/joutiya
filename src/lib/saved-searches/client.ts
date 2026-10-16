import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/auth/client";
import { SEARCH_API, type SavedSearchAlert, type SavedSearchPatch, type SavedSearchView } from "@/lib/contracts/search";
import { canonicalSearchParams, type SearchParams, type StoredSearchParams } from "@/lib/search/params";

// Browser side of the saved searches (design D18): thin wrappers over /api/saved-searches.

/** What the API stores: the canonical parameters without the page (strict schema server side). */
export function storedFormOf(params: SearchParams): StoredSearchParams {
  const { page: _page, ...stored } = canonicalSearchParams(params);
  return stored as StoredSearchParams;
}

export function listSavedSearches(): Promise<{ searches: SavedSearchView[] }> {
  return apiGet<{ searches: SavedSearchView[] }>(SEARCH_API.savedSearches);
}

export function saveSearch(input: { name: string; params: SearchParams; alert: SavedSearchAlert }): Promise<{ search: SavedSearchView }> {
  return apiPost<{ search: SavedSearchView }>(SEARCH_API.savedSearches, { name: input.name, params: storedFormOf(input.params), alert: input.alert });
}

export function updateSavedSearch(id: string, patch: SavedSearchPatch): Promise<{ search: SavedSearchView }> {
  return apiPatch<{ search: SavedSearchView }>(SEARCH_API.savedSearch(id), patch);
}

export function deleteSavedSearch(id: string): Promise<void> {
  return apiDelete(SEARCH_API.savedSearch(id));
}

/** The id an `saved_search_exists` refusal points to (409 details). */
export function existingSearchId(details: unknown): string | null {
  const id = typeof details === "object" && details !== null ? (details as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : null;
}
