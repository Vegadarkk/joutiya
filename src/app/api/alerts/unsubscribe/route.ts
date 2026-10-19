import { apiRoute } from "@/lib/http/route";
import { handleUnsubscribe } from "@/lib/alerts/handlers";

// /api/alerts/unsubscribe: POST ?t=<token> (RFC 8058 one-click) or { token } -> 204. Token-authenticated:
// no session, no Origin/CSRF check (src/lib/alerts/handlers.ts).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request) => handleUnsubscribe(request));
