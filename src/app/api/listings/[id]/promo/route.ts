import { handleEndPromo, handlePromo } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// /api/listings/{id}/promo: PUT a promotion of a Pro listing (catalogue §4), DELETE to end it.
export const dynamic = "force-dynamic";
export const PUT = apiRoute((request, context) => handlePromo(request, context.params));
export const DELETE = apiRoute((request, context) => handleEndPromo(request, context.params));
