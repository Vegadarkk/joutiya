import { handleStorefrontRead, handleStorefrontUpdate } from "@/lib/account/storefront";
import { apiRoute } from "@/lib/http/route";

// GET and POST /api/account/storefront: the signed-in member's storefront settings (vitrine-avis §1).
export const GET = apiRoute(handleStorefrontRead);
export const POST = apiRoute(handleStorefrontUpdate);
