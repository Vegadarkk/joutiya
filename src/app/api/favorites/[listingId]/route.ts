import { apiRoute } from "@/lib/http/route";
import { handleDeleteFavorite, handlePutFavorite } from "@/lib/favorites/handlers";

// /api/favorites/{listingId}: PUT (add, idempotent), DELETE (remove, 204).
export const dynamic = "force-dynamic";
export const PUT = apiRoute((request, context) => handlePutFavorite(request, context.params));
export const DELETE = apiRoute((request, context) => handleDeleteFavorite(request, context.params));
