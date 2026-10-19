import { apiRoute } from "@/lib/http/route";
import { handleFavoriteIds } from "@/lib/favorites/handlers";

// /api/favorites/ids: GET -> { ids } (hearts on cards and listing pages, once per page).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handleFavoriteIds(request));
