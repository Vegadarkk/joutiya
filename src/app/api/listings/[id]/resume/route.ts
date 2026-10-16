import { transitionHandler } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/listings/{id}/resume (lifecycle, design D16).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => transitionHandler("resume")(request, context.params));
