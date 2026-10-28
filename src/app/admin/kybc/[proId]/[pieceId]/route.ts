import { requireStaff } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { uploadIdSchema } from "@/lib/contracts/media";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { getUpload } from "@/lib/db/repositories/uploads";
import { notFound } from "@/lib/http/errors";
import { apiRoute } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";

// GET /kybc/{proId}/{pieceId} on the admin host (rewritten here by proxy.ts; the public host
// answers 404): one KYBC piece of a Pro application, streamed from the private bucket for the
// review (phase 7 design §4; no presigned GET exists). Moderators and admins only, a piece the
// application lists only, under a per-staff limiter; every view is journaled before the bytes are
// read, and a view the journal cannot record is refused (identity documents). PDFs download as
// attachments (never rendered in the back office's origin), images display inline; never cached.

export const dynamic = "force-dynamic";

/** A piece is at most 10 MiB as uploaded; a re-encoded PNG may come out a little larger. */
const MAX_PIECE_BYTES = 12 * 1024 * 1024;

function store(): ObjectStore {
  try {
    return objectStore();
  } catch (error) {
    if (isStorageNotConfigured(error)) throw notFound();
    throw error;
  }
}

export const GET = apiRoute(async (request, context) => {
  const staff = await requireStaff(request, { roles: ["moderator", "admin"] });
  await enforceLimit("pro.kybc.view.uid", staff.user.uid);
  const params = await context.params;
  const proId = proIdSchema.safeParse(params["proId"]);
  const pieceId = uploadIdSchema.safeParse(params["pieceId"]);
  if (!proId.success || !pieceId.success) throw notFound();
  const profile = await getProProfile(proId.data);
  if (!profile || !profile.kybc.uploadIds.includes(pieceId.data)) throw notFound();
  const upload = await getUpload(pieceId.data);
  if (!upload || upload.purpose !== "kyb" || upload.status !== "ready" || !upload.finalKey || upload.ownerUid !== profile.ownerUid) throw notFound();
  await audit(
    {
      actorUid: staff.user.uid,
      actorRole: staff.role,
      action: "pro.kybc.view",
      target: { type: "pro", id: proId.data },
      automated: false,
      reason: `piece ${pieceId.data}`,
      ip: requestIdentity(request.headers).ip,
    },
    { required: true },
  );
  const body = await store().get("private", upload.finalKey, { maxBytes: MAX_PIECE_BYTES });
  if (!body) throw notFound();
  const pdf = upload.declaredType === "application/pdf";
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": upload.declaredType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": pdf ? `attachment; filename="kybc-${proId.data}-${pieceId.data}.pdf"` : "inline",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
