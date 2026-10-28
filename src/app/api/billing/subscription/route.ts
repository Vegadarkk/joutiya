import { apiRoute } from "@/lib/http/route";
import { handleSubscription } from "@/lib/payments/handlers";

// GET /api/billing/subscription: the shop's plan, subscription and offers (phase 7 design §7).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handleSubscription(request));
