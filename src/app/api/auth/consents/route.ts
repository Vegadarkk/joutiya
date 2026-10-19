import { handleConsents } from "@/lib/auth/consents";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/consents: renews the transfers consent (art. 44 loi 09-08) of the signed-in member.
export const POST = apiRoute(handleConsents);
