import { apiRoute } from "@/lib/http/route";
import { handleStock } from "@/lib/pro/handlers";

// GET /api/pro/stock: the shop's listings with a stock reference (Concession pack, design concession.md §4).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleStock);
