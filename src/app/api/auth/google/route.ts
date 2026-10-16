import { handleGoogle } from "@/lib/auth/google";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/google: Google Identity Services credential -> session (or sign-up with consents).
export const POST = apiRoute(handleGoogle);
