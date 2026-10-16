import { handleDelete, handleGet, handlePatch } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// /api/listings/{id}: GET (owner view), PATCH (wizard autosave, edits), DELETE (removal, 204).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handleGet(request, context.params));
export const PATCH = apiRoute((request, context) => handlePatch(request, context.params));
export const DELETE = apiRoute((request, context) => handleDelete(request, context.params));
