import { handleClientToken } from "@/lib/auth/session-handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/client-token: custom token for the browser SDK (session + Origin + CSRF required).
export const POST = apiRoute(handleClientToken);
