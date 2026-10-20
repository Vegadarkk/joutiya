import { apiRoute } from "@/lib/http/route";
import { handleInvoices } from "@/lib/payments/handlers";

// GET /api/billing/invoices: the shop's latest Stripe invoices (phase 7 design §7).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request) => handleInvoices(request));
