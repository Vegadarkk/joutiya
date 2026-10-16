import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { savedSearchCreateSchema, savedSearchIdSchema, savedSearchPatchSchema, type SavedSearchView } from "@/lib/contracts/search";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json, noContent } from "@/lib/http/route";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { createSearch, listSearches, patchSearch, removeSearch } from "./service";

// Route handlers of /api/saved-searches/** (design D18, §3): member session (Origin + CSRF on
// mutations), strict bodies, the per-account limiter before the first engine or Firestore call.

type Params = Promise<Record<string, string | string[] | undefined>>;

async function searchIdOf(params: Params): Promise<string> {
  const { id } = await params;
  const parsed = savedSearchIdSchema.safeParse(id);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** GET /api/saved-searches -> { searches }. */
export async function handleListSearches(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  await enforceLimit("savedSearch.read.uid", auth.user.uid);
  const body: { searches: SavedSearchView[] } = { searches: await listSearches(auth.user.uid) };
  return json(body);
}

/** POST /api/saved-searches -> 201 { search }; 409 saved_search_exists (details.id) or saved_search_limit. */
export async function handleCreateSearch(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, savedSearchCreateSchema);
  await enforceLimit("savedSearch.write.uid", auth.user.uid);
  const body: { search: SavedSearchView } = { search: await createSearch(auth.user.uid, input) };
  return json(body, { status: 201 });
}

/** PATCH /api/saved-searches/{id} -> { search }. */
export async function handlePatchSearch(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await searchIdOf(params);
  const patch = await readJson(request, savedSearchPatchSchema);
  await enforceLimit("savedSearch.write.uid", auth.user.uid);
  const body: { search: SavedSearchView } = { search: await patchSearch(auth.user.uid, id, patch) };
  return json(body);
}

/** DELETE /api/saved-searches/{id} -> 204. */
export async function handleDeleteSearch(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await searchIdOf(params);
  await enforceLimit("savedSearch.write.uid", auth.user.uid);
  await removeSearch(auth.user.uid, id);
  return noContent();
}
