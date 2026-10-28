import { apiRoute } from "@/lib/http/route";
import { handleBillingPortal } from "@/lib/payments/handlers";

// POST /api/billing/portal: opens the shop's Stripe Customer Portal (phase 7 design §7).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request) => handleBillingPortal(request));
