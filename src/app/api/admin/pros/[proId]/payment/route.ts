import { requireStaff } from "@/lib/auth/guards";
import { shopPaymentActionSchema, type ShopPaymentAdminView } from "@/lib/contracts/seller-payment";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { setShopPaymentSuspension, shopPaymentAdmin } from "@/lib/pro/seller-payment";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// A shop's « Payer chez le vendeur » button in the back office: its state (GET) and the
// moderator's suspension or restoration (POST, reason required). Moderators and admins.

export const dynamic = "force-dynamic";

async function proId(context: { params: Promise<Record<string, string | string[] | undefined>> }): Promise<string> {
  const id = proIdSchema.safeParse((await context.params)["proId"]);
  if (!id.success) throw notFound();
  return id.data;
}

export const GET = apiRoute(async (request, context) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  return json<ShopPaymentAdminView>(await shopPaymentAdmin(await proId(context)));
});

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const id = await proId(context);
  await enforceLimit("pro.decision.uid", ctx.user.uid);
  const body = await readJson(request, shopPaymentActionSchema);
  return json<ShopPaymentAdminView>(await setShopPaymentSuspension(ctx, id, body));
});
