import { apiRoute } from "@/lib/http/route";
import { handlePassCheckout } from "@/lib/payments/handlers";

// POST /api/billing/pass: opens the Stripe Checkout of a Pass Boutique (design phase-7/boutique-temporaire.md §1).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request) => handlePassCheckout(request));
