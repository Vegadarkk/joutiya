import { handleUserLookup } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/admin/users?publicId=: an account's moderation view by its public profile id (design D24).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleUserLookup);
