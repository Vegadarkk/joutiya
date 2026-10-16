import { handleUserGet } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/admin/users/{uid}: status, strikes, next ladder step, reporter accuracy, decisions (design D14, D15, D24).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleUserGet);
