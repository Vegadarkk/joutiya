import { requireUser } from "@/lib/auth/guards";
import { sellerPaymentInputSchema, type SellerPaymentView } from "@/lib/contracts/seller-payment";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { saveSellerPayment, sellerPaymentSettings } from "@/lib/pro/seller-payment";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// « Payer chez le vendeur » settings of the signed-in owner's shop (design phase-7/boutique-temporaire.md §2).

export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  const auth = await requireUser(request);
  await enforceLimit("pro.read.uid", auth.user.uid);
  return json<SellerPaymentView>(await sellerPaymentSettings(auth));
});

export const PUT = apiRoute(async (request) => {
  const auth = await requireUser(request, { mutation: true });
  await enforceLimit("pro.payment.uid", auth.user.uid);
  const body = await readJson(request, sellerPaymentInputSchema);
  return json<SellerPaymentView>(await saveSellerPayment(auth, body));
});
