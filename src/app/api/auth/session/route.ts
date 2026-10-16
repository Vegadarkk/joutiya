import { handleSession } from "@/lib/auth/session-handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/session: Firebase ID token (google.com, existing account) -> session cookie.
export const POST = apiRoute(handleSession);
