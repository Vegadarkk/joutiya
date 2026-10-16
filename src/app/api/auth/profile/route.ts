import { handleProfile } from "@/lib/auth/profile";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/profile: display name and locale of the signed-in person.
export const POST = apiRoute(handleProfile);
