import { requireSameOrigin } from "@/lib/auth/guards";
import { openPaymentSchema, type OpenPaymentResponse } from "@/lib/contracts/seller-payment";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { openShopPayment } from "@/lib/pro/seller-payment";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// « Payer chez le vendeur »: the buyer's click asks for the shop's payment link now (state,
// suspension and allowlist checked at click time; the cached pages never hold the link). Anonymous,
// same origin, limited per IP. POST: a prefetch never counts a click.

export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request, context) => {
  requireSameOrigin(request);
  const { ipBucket } = requestIdentity(request.headers);
  await enforceLimit("shop.payment.ip", ipBucket);
  const id = proIdSchema.safeParse((await context.params)["proId"]);
  if (!id.success) throw notFound();
  const body = await readJson(request, openPaymentSchema);
  return json<OpenPaymentResponse>(await openShopPayment(id.data, body.listingId, ipBucket));
});
