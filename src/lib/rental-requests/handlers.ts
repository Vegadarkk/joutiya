import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { cidSchema } from "@/lib/contracts/messaging";
import { rentalRequestActionSchema, type RentalRequestResponse } from "@/lib/contracts/rental-requests";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { MESSAGING_QUOTAS } from "@/lib/messaging/service";
import { assertQuotas } from "@/lib/quota/gate";
import { assertLimit, consumeLimit } from "@/lib/rate-limit/limiter";
import { actOnRentalRequest } from "./service";

// POST /api/conversations/{cid}/rental-request (rental pack §6): the messaging write path of
// handlers.ts for one booking request step. Members only, revocation checked, Origin + CSRF, a
// suspended account refused; body, the request limiter (a new request only, 20 a day) then the
// thread's send limiter, the Firestore write quota gate, then the step.

type Params = Promise<Record<string, string | string[] | undefined>>;

const RENTAL_REQUEST_BODY_MAX = 2 * 1024;

export async function handleRentalRequest(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true });
  const parsed = cidSchema.safeParse((await params).cid);
  if (!parsed.success) throw notFound();
  const cid = parsed.data;
  const action = await readJson(request, rentalRequestActionSchema, RENTAL_REQUEST_BODY_MAX);
  if (action.action === "request") assertLimit("rental.request.uid", await consumeLimit("rental.request.uid", auth.user.uid));
  assertLimit("message.send.thread", await consumeLimit("message.send.thread", `${auth.user.uid}:${cid}`));
  await assertQuotas(MESSAGING_QUOTAS);
  const body: RentalRequestResponse = await actOnRentalRequest({ uid: auth.user.uid, claims: auth.user.claims }, cid, action);
  return json(body, { status: 201 });
}
