import { handlePackCheckout, handlePacks } from "@/lib/payments/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/wallet/packs: credit packs on sale; POST: opens the payment of one (phase 7 design §6).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handlePacks(request));
export const POST = apiRoute((request) => handlePackCheckout(request));
