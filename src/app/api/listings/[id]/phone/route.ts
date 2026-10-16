import { handlePhone } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/listings/{id}/phone: the seller's verified number, under the §6 reveal rules (no-store).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handlePhone(request, context.params));
