import { requireStaff } from "@/lib/auth/guards";
import { paymentHostReviewSchema, type SellerPaymentsAdminView } from "@/lib/contracts/seller-payment";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { reviewPaymentHost } from "@/lib/pro/seller-payment";

// An admin approves a waiting payment host (added to the list) or rejects it (its links are dropped, the owners told).

export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["admin"] });
  const body = await readJson(request, paymentHostReviewSchema);
  return json<SellerPaymentsAdminView>(await reviewPaymentHost(ctx, body));
});
