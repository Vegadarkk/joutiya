import { handleWallet } from "@/lib/payments/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/wallet: credits wallet and ledger of the member or their shop (phase 7 design §5).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handleWallet(request));
