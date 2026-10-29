import { apiRoute } from "@/lib/http/route";
import { handleSections } from "@/lib/pro/handlers";

// PUT /api/pro/me/sections: the storefront's sections, replaced whole (catalogue §5).
export const dynamic = "force-dynamic";
export const PUT = apiRoute(handleSections);
