import { handleAuthorityGet, handleAuthorityUpdate } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// One authority request, admin only (design D17): read (GET), answered or closed (PATCH).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleAuthorityGet);
export const PATCH = apiRoute(handleAuthorityUpdate);
