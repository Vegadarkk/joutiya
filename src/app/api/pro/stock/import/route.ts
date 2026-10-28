import { apiRoute } from "@/lib/http/route";
import { handleStockImport } from "@/lib/pro/handlers";

// POST /api/pro/stock/import: preview or apply a stock CSV (Concession pack, design concession.md §4).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleStockImport);
