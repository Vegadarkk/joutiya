import { handleLogout } from "@/lib/auth/session-handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/logout: clears the cookies, revokes the tokens; 204.
export const POST = apiRoute(handleLogout);
