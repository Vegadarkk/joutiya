import { handleMine } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/listings/mine?status=drafts|active|pending|ended ("Mes annonces").
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleMine);
