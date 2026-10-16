import { requireStaff } from "@/lib/auth/guards";
import { invite, inviteSchema, list, type StaffInviteResponse, type StaffListResponse } from "@/lib/auth/staff";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";

// Roster of the back office (admins only, §6 "Seul un admin attribue un rôle").

export const GET = apiRoute(async (request) => {
  await requireStaff(request, { roles: ["admin"] });
  return json<StaffListResponse>(await list());
});

export const POST = apiRoute(async (request) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["admin"] });
  const body = await readJson(request, inviteSchema);
  const result = await invite(ctx, body, requestIdentity(request.headers));
  return json<StaffInviteResponse>(result, { status: 201 });
});
