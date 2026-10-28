import { audit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/guards";
import { acceptGuideLink } from "@/lib/guide/state";
import { apiRoute, json } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// Staff "verified" on a source of the admin procedures guide (design guide-demarches G4): a person
// read the official page, its current fingerprint becomes the reference and the review date moves
// to now. POST /api/admin/guide/links/{linkId}/accept, moderators and admins, admin host only.

export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const raw = (await context.params)["linkId"];
  const id = typeof raw === "string" ? raw : "";
  await enforceLimit("admin.guide.uid", ctx.user.uid);
  const now = new Date();
  const state = await acceptGuideLink(id, ctx.user.uid, now);
  await audit({ actorUid: ctx.user.uid, actorRole: ctx.role, action: "guide.link.accept", target: { type: "guideLink", id }, automated: false, ip: requestIdentity(request.headers).ip, at: now });
  return json({ id, acceptedAt: state.acceptedAt ?? now.toISOString() });
});
