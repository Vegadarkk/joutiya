import "server-only";
import { SAVED_SEARCHES_MAX, SAVED_SEARCH_NAME_MAX, type SavedSearchPatch, type SavedSearchView, type savedSearchCreateSchema } from "@/lib/contracts/search";
import type { SavedSearchDoc } from "@/lib/db/schemas";
import { HttpError, notFound } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { canonicalSearchParams, isBlankSearch, storedSearchParamsSchema, type SearchParams, type StoredSearchParams } from "@/lib/search/params";
import { runSearch } from "@/lib/search/service";
import { SearchUnavailableError } from "@/lib/search/types";
import type { z } from "@/lib/zod";
import { SavedSearchExistsError, SavedSearchLimitError, createSavedSearch, deleteSavedSearch, listSavedSearches, updateSavedSearch, type SavedSearchRecord } from "./repository";

// Saved searches (design D18): the canonical parameters (no page), a name, a daily alert on by
// default. The alert cursor starts at the newest listing matching at save time, so the first
// digest only holds listings published after the save.

export type SavedSearchCreateInput = z.output<typeof savedSearchCreateSchema>;

/** Fallback name when the client sends none (the dialog always proposes one). */
export const DEFAULT_SEARCH_NAME = "Ma recherche";

export function toSavedSearchView(record: SavedSearchRecord): SavedSearchView {
  return {
    id: record.id,
    name: record.name,
    params: record.params,
    alert: record.alert,
    createdAt: record.createdAt.toISOString(),
    ...(record.lastAlertAt ? { lastAlertAt: record.lastAlertAt.toISOString() } : {}),
  };
}

/** Canonical stored form: contradictions removed, page dropped, strict whitelist. */
export function storedParams(params: SearchParams): StoredSearchParams {
  const { page: _page, ...canonical } = canonicalSearchParams(params);
  const parsed = storedSearchParamsSchema.safeParse(canonical);
  if (!parsed.success) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "params", code: "invalid_value" }] });
  return parsed.data;
}

/** sortAt of the newest listing matching now (exact matches only); the save time when the engine is down. */
export async function newestSortAt(params: StoredSearchParams, now: Date): Promise<number> {
  try {
    const response = await runSearch({ ...params, sort: "recent" }, { hitsPerPage: 1, featured: false, facets: false, now });
    if (response.approximate) return 0;
    return response.hits.reduce((newest, hit) => Math.max(newest, Date.parse(hit.sortAt) || 0), 0);
  } catch (error) {
    if (!(error instanceof SearchUnavailableError)) throw error;
    logger.warn({ err: error.message }, "saved search: engine down, alert starts now");
    return now.getTime();
  }
}

export async function listSearches(uid: string): Promise<SavedSearchView[]> {
  return (await listSavedSearches(uid)).map(toSavedSearchView);
}

export async function createSearch(uid: string, input: SavedSearchCreateInput, now = new Date()): Promise<SavedSearchView> {
  const params = storedParams(input.params);
  // Every listing would match: nothing to save, and an alert would be a daily list of everything.
  if (isBlankSearch(params)) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "params", code: "too_small" }] });
  const doc: SavedSearchDoc = {
    name: input.name ?? params.q?.slice(0, SAVED_SEARCH_NAME_MAX).trim() ?? DEFAULT_SEARCH_NAME,
    params,
    alert: input.alert,
    lastNotifiedSortAt: await newestSortAt(params, now),
    createdAt: now,
    updatedAt: now,
  };
  try {
    return toSavedSearchView(await createSavedSearch(uid, doc, SAVED_SEARCHES_MAX));
  } catch (error) {
    if (error instanceof SavedSearchExistsError) throw new HttpError(409, "saved_search_exists", undefined, { details: { id: error.id } });
    if (error instanceof SavedSearchLimitError) throw new HttpError(409, "saved_search_limit");
    throw error;
  }
}

/** Rename and/or switch the alert. Switching it back on starts after now: no backlog of the paused weeks. */
export async function patchSearch(uid: string, id: string, patch: SavedSearchPatch, now = new Date()): Promise<SavedSearchView> {
  const updated = await updateSavedSearch(uid, id, (current) => {
    const next: Partial<SavedSearchDoc> = { updatedAt: now };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.alert !== undefined) {
      next.alert = patch.alert;
      if (patch.alert === "daily" && current.alert === "none") next.lastNotifiedSortAt = Math.max(current.lastNotifiedSortAt, now.getTime());
    }
    return next;
  });
  if (!updated) throw notFound();
  return toSavedSearchView(updated);
}

export async function removeSearch(uid: string, id: string): Promise<void> {
  if (!(await deleteSavedSearch(uid, id))) throw notFound();
}
