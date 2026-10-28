import { apiRoute } from "@/lib/http/route";
import { handlePlanCheckout } from "@/lib/payments/handlers";

// POST /api/billing/checkout: opens the Stripe Checkout of a Pro plan (phase 7 design §7).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request) => handlePlanCheckout(request));
