import { apiRoute } from "@/lib/http/route";
import { handleFavorites } from "@/lib/favorites/handlers";

// /api/favorites: GET ?cursor= (the "Mes favoris" page, 48 per page).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handleFavorites(request));
