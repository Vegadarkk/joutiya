import { apiRoute } from "@/lib/http/route";
import { handleSearch } from "@/lib/search/handlers";

// GET /api/search?<search params>: results, À la Une, facets (design §3). 403 turnstile_required,
// 429 over the limits (D13); 503 search_unavailable when the engine is down (D2).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleSearch);
