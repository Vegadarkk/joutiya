import { apiRoute } from "@/lib/http/route";
import { handleDeleteSearch, handlePatchSearch } from "@/lib/saved-searches/handlers";

// /api/saved-searches/{id}: PATCH (rename, alert on/off), DELETE (204).
export const dynamic = "force-dynamic";
export const PATCH = apiRoute((request, context) => handlePatchSearch(request, context.params));
export const DELETE = apiRoute((request, context) => handleDeleteSearch(request, context.params));
