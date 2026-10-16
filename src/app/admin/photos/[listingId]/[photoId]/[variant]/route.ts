import { requireStaff } from "@/lib/auth/guards";
import { notFound } from "@/lib/http/errors";
import { apiRoute } from "@/lib/http/route";
import { MEDIA_CONTENT_TYPE } from "@/lib/media/urls";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { parseStaffPhotoParams, readStaffPhoto } from "../../../../_lib/staff-photos";

// GET /photos/{listingId}/{photoId}/{variant} on the admin host (rewritten here by proxy.ts; the
// public host answers 404): a listing photo for the moderation review, read from the private
// bucket (a removed listing's) or the media bucket. Moderators and admins only; never cached
// (evidence kept for appeals and authorities, not for shared caches). A handful of images per
// review: public photos are still served by R2 (media host), never by the VM.

export const dynamic = "force-dynamic";

function store(): ObjectStore {
  try {
    return objectStore();
  } catch (error) {
    if (isStorageNotConfigured(error)) throw notFound();
    throw error;
  }
}

export const GET = apiRoute(async (request, context) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  const target = parseStaffPhotoParams(await context.params);
  if (!target) throw notFound();
  const body = await readStaffPhoto(store(), target);
  if (!body) throw notFound();
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": MEDIA_CONTENT_TYPE,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
