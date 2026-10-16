import { handleSignup } from "@/lib/auth/signup";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/signup (§6 "Inscription par e-mail"): the logic lives in src/lib/auth/signup.ts.
export const POST = apiRoute(handleSignup);
