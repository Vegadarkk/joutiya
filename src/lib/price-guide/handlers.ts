import "server-only";
import { listingIdSchema } from "@/lib/contracts/listings";
import type { PriceGuideResponse } from "@/lib/contracts/price-guide";
import { getListing } from "@/lib/db/repositories/listings";
import { notFound } from "@/lib/http/errors";
import { json } from "@/lib/http/route";
import { assertQuotas, PUBLIC_READ_QUOTAS } from "@/lib/quota/gate";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { isIndexable } from "@/lib/search/document";
import { cachedGuide, priceGuideFor, subjectOfListing } from "./service";

// GET /api/listings/{id}/price-guide (Carte vivante lot 5): the « Prix repère » of a published
// listing, for the map's detail panel. Anonymous, limited per IP; answered from the 24 h cache when
// it holds the listing (no Firestore read), else one listing read (public read quota gate), the
// engine, and the cache. A listing that is not published and visible answers 404. Public data only:
// statistics of published listings and the listing's own price. Cacheable by the browser and the
// edge for an hour (the guide moves slowly).

type Params = Promise<Record<string, string | string[] | undefined>>;

export const PRICE_GUIDE_CACHE_CONTROL = "public, max-age=3600, s-maxage=3600";

export async function handlePriceGuide(request: Request, params: Params): Promise<Response> {
  const parsed = listingIdSchema.safeParse((await params).id);
  if (!parsed.success) throw notFound();
  await enforceLimit("priceguide.ip", requestIdentity(request.headers).ipBucket);
  const id = parsed.data;
  let body: PriceGuideResponse;
  const cached = await cachedGuide(id);
  if (cached) {
    body = { guide: cached.guide, price: cached.price };
  } else {
    await assertQuotas(PUBLIC_READ_QUOTAS);
    const listing = await getListing(id);
    const subject = listing && isIndexable(listing) ? subjectOfListing(listing) : null;
    if (!subject) throw notFound();
    body = { guide: await priceGuideFor(subject), price: subject.price };
  }
  return json(body, { headers: { "Cache-Control": PRICE_GUIDE_CACHE_CONTROL } });
}
