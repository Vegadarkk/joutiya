import { handleComplete } from "@/lib/uploads/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/uploads/{id}/complete: the browser's PUT is done; the media pipeline runs (D12).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleComplete(request, context.params));
