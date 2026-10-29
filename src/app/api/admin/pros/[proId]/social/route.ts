import { requireStaff } from "@/lib/auth/guards";
import { shopSocialActionSchema, type ProSocialView } from "@/lib/contracts/pro";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { setShopSocialHidden, shopSocialAdmin } from "@/lib/pro/social-links";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// A shop's social links in the back office: their state (GET) and the moderator's hiding or
// restoration (POST, reason required, mailed to the owner). Moderators and admins.

export const dynamic = "force-dynamic";

async function proId(context: { params: Promise<Record<string, string | string[] | undefined>> }): Promise<string> {
  const id = proIdSchema.safeParse((await context.params)["proId"]);
  if (!id.success) throw notFound();
  return id.data;
}

export const GET = apiRoute(async (request, context) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  return json<ProSocialView>(await shopSocialAdmin(await proId(context)));
});

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const id = await proId(context);
  await enforceLimit("pro.decision.uid", ctx.user.uid);
  const body = await readJson(request, shopSocialActionSchema);
  return json<ProSocialView>(await setShopSocialHidden(ctx, id, body));
});
