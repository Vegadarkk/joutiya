import { transitionHandler } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/listings/{id}/sold (lifecycle, design D16).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => transitionHandler("sold")(request, context.params));
