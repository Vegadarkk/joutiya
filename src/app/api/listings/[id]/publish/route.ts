import { handlePublish } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/listings/{id}/publish (§7 pre-publication, design D8).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handlePublish(request, context.params));
