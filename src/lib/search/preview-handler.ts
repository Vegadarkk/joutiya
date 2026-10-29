import "server-only";
import { LOCALES, type Locale } from "@/config/site";
import { listingIdSchema } from "@/lib/contracts/listings";
import { HttpError, notFound } from "@/lib/http/errors";
import { json } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { listingPreview } from "./preview";
import { SearchUnavailableError } from "./types";

// GET /api/listings/{id}/preview?locale=fr: the map's detail panel cards (src/lib/search/preview.ts).
// Anonymous and index-only (no Firestore read): limited per IP and per IPv6 /48 like the search,
// never cached (a listing withdrawn or edited is reflected at once). Unknown locale: fr.

type Params = Promise<Record<string, string | string[] | undefined>>;

export async function handleListingPreview(request: Request, params: Params): Promise<Response> {
  const parsed = listingIdSchema.safeParse((await params).id);
  if (!parsed.success) throw notFound();
  const identity = requestIdentity(request.headers);
  await enforceLimit("preview.ip", identity.ipBucket);
  if (identity.ip48) await enforceLimit("preview.ip48", identity.ip48);
  const asked = new URL(request.url).searchParams.get("locale");
  const locale: Locale = (LOCALES as readonly string[]).includes(asked ?? "") ? (asked as Locale) : "fr";
  try {
    const preview = await listingPreview(parsed.data, locale);
    if (!preview) throw notFound();
    return json(preview);
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw new HttpError(503, "search_unavailable", undefined, { headers: { "Retry-After": "30" } });
    throw error;
  }
}
