import { z } from "@/lib/zod";
import { requireStaff } from "@/lib/auth/guards";
import { revoke } from "@/lib/auth/staff";
import { notFound } from "@/lib/http/errors";
import { apiRoute, noContent } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";

/** One Firestore document id, never a path: a slash would address a document of a subcollection. */
const uidSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// Revocation of a member (admins only, never oneself).
export const DELETE = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["admin"] });
  const uid = uidSchema.safeParse((await context.params)["uid"]);
  if (!uid.success) throw notFound();
  await revoke(ctx, uid.data, requestIdentity(request.headers));
  return noContent();
});
