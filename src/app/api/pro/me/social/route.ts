import { apiRoute } from "@/lib/http/route";
import { handleSocial } from "@/lib/pro/handlers";

// PUT /api/pro/me/social: the shop's social links, shown on its storefront (src/config/social-links.ts).
export const dynamic = "force-dynamic";
export const PUT = apiRoute(handleSocial);
