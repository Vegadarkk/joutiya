import { handleSection } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// PUT /api/listings/{id}/section: the storefront section of a Pro listing (catalogue §5).
export const dynamic = "force-dynamic";
export const PUT = apiRoute((request, context) => handleSection(request, context.params));
