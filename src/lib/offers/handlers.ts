import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { cidSchema } from "@/lib/contracts/messaging";
import { offerActionSchema, type OfferResponse } from "@/lib/contracts/offers";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { MESSAGING_QUOTAS } from "@/lib/messaging/service";
import { assertQuotas } from "@/lib/quota/gate";
import { assertLimit, consumeLimit } from "@/lib/rate-limit/limiter";
import { actOnOffer } from "./service";

// POST /api/conversations/{cid}/offer (Carte vivante lot 5): the messaging write path of
// handlers.ts for one offer step. Members only, revocation checked, Origin + CSRF, a suspended
// account refused; body, the offer limiters (a new offer: 20 a day per buyer; an offer or a
// counter-offer: 5 per conversation in 24 h), the thread's send limiter, the Firestore write quota
// gate, then the step.

type Params = Promise<Record<string, string | string[] | undefined>>;

const OFFER_BODY_MAX = 2 * 1024;

export async function handleOffer(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true });
  const parsed = cidSchema.safeParse((await params).cid);
  if (!parsed.success) throw notFound();
  const cid = parsed.data;
  const action = await readJson(request, offerActionSchema, OFFER_BODY_MAX);
  if (action.action === "make") assertLimit("offer.uid", await consumeLimit("offer.uid", auth.user.uid));
  if (action.action === "make" || action.action === "counter") assertLimit("offer.thread", await consumeLimit("offer.thread", `${auth.user.uid}:${cid}`));
  assertLimit("message.send.thread", await consumeLimit("message.send.thread", `${auth.user.uid}:${cid}`));
  await assertQuotas(MESSAGING_QUOTAS);
  const body: OfferResponse = await actOnOffer({ uid: auth.user.uid, claims: auth.user.claims }, cid, action);
  return json(body, { status: 201 });
}
