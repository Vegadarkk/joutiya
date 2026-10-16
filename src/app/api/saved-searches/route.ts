import { apiRoute } from "@/lib/http/route";
import { handleCreateSearch, handleListSearches } from "@/lib/saved-searches/handlers";

// /api/saved-searches: GET (the account's searches), POST (save the current search, 10 at most).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handleListSearches(request));
export const POST = apiRoute((request) => handleCreateSearch(request));
