import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { favoriteListingIdSchema, type FavoriteView, type FavoritesPage } from "@/lib/contracts/search";
import { notFound } from "@/lib/http/errors";
import { json, noContent } from "@/lib/http/route";
import { consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { addFavorite, favoriteIdsOf, favoritesPage, removeFavorite } from "./service";

// Route handlers of /api/favorites/** (design D17, §3): member session on every route (Origin +
// CSRF on PUT/DELETE), the per-account limiter before the first Valkey, engine or Firestore call.
// Another account's favorites are never addressable: the uid comes from the session only.

type Params = Promise<Record<string, string | string[] | undefined>>;

async function listingIdOf(params: Params): Promise<string> {
  const { listingId } = await params;
  const parsed = favoriteListingIdSchema.safeParse(listingId);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** GET /api/favorites/ids -> { ids } (hearts state of every page). */
export async function handleFavoriteIds(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  await enforceLimit("favorites.read.uid", auth.user.uid);
  const body: { ids: string[] } = { ids: await favoriteIdsOf(auth.user.uid) };
  return json(body);
}

/**
 * GET /api/favorites?cursor= -> FavoritesPage. Charged in Firestore documents on the daily
 * `favorites.docs.uid`: one point before the read, so a spent budget reads nothing, then the rest.
 */
export async function handleFavorites(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  await enforceLimit("favorites.read.uid", auth.user.uid);
  await enforceLimit("favorites.docs.uid", auth.user.uid);
  const body: FavoritesPage = await favoritesPage(auth.user.uid, cursor || undefined);
  // The page read one favorite more when another page follows.
  const documents = body.favorites.length + (body.next ? 1 : 0);
  if (documents > 1) await consumeLimit("favorites.docs.uid", auth.user.uid, documents - 1);
  return json(body);
}

/** PUT /api/favorites/{listingId} -> 201 (added) or 200 (already a favorite) { favorite }. */
export async function handlePutFavorite(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const listingId = await listingIdOf(params);
  await enforceLimit("favorites.write.uid", auth.user.uid);
  const { created, favorite } = await addFavorite(auth.user.uid, listingId);
  const body: { favorite: FavoriteView } = { favorite };
  return json(body, { status: created ? 201 : 200 });
}

/** DELETE /api/favorites/{listingId} -> 204 (also when it was not a favorite). */
export async function handleDeleteFavorite(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const listingId = await listingIdOf(params);
  await enforceLimit("favorites.write.uid", auth.user.uid);
  await removeFavorite(auth.user.uid, listingId);
  return noContent();
}
