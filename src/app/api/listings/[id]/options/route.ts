import { handleBuyOption, handleListingOptions } from "@/lib/payments/handlers";
import { apiRoute } from "@/lib/http/route";

// GET / POST /api/listings/{id}/options: paid options of a listing (phase 7 design §5).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handleListingOptions(request, context.params));
export const POST = apiRoute((request, context) => handleBuyOption(request, context.params));
