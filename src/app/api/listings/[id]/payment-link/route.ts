import { handlePaymentLink } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// PUT /api/listings/{id}/payment-link: a Pro listing's own « Payer chez le vendeur » link (catalogue §6).
export const dynamic = "force-dynamic";
export const PUT = apiRoute((request, context) => handlePaymentLink(request, context.params));
