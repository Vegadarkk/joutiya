import { handleLogin } from "@/lib/auth/login";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/login (§6 "Connexion par e-mail").
export const POST = apiRoute(handleLogin);
