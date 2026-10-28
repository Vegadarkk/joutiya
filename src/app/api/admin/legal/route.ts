import { requireStaff } from "@/lib/auth/guards";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { legalUpdateSchema, readLegalAdmin, saveLegalConfig, type LegalAdminView } from "@/lib/legal/admin";
import { requestIdentity } from "@/lib/rate-limit/keys";

// Legal variables of the site, Firestore `config/legal` (phase 6, D13): admins only, journaled.

export const GET = apiRoute(async (request) => {
  await requireStaff(request, { roles: ["admin"] });
  return json<LegalAdminView>(await readLegalAdmin());
});

export const PUT = apiRoute(async (request) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["admin"] });
  const body = await readJson(request, legalUpdateSchema);
  return json<LegalAdminView>(await saveLegalConfig(ctx, body, requestIdentity(request.headers).ip));
});
