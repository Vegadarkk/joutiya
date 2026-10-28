import { requireStaff } from "@/lib/auth/guards";
import { sellerPaymentsUpdateSchema, type SellerPaymentsAdminView } from "@/lib/contracts/seller-payment";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { saveSellerPaymentHosts, sellerPaymentsAdmin } from "@/lib/pro/seller-payment";

// Payment hosts of « Payer chez le vendeur », Firestore `config/sellerPayments`, and the links
// waiting for a host's review. Admins only, journaled.

export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  await requireStaff(request, { roles: ["admin"] });
  return json<SellerPaymentsAdminView>(await sellerPaymentsAdmin());
});

export const PUT = apiRoute(async (request) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["admin"] });
  const body = await readJson(request, sellerPaymentsUpdateSchema);
  return json<SellerPaymentsAdminView>(await saveSellerPaymentHosts(ctx, body.hosts));
});
