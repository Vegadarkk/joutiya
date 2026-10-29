import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { appointmentActionSchema, type AppointmentResponse } from "@/lib/contracts/appointments";
import { cidSchema } from "@/lib/contracts/messaging";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { MESSAGING_QUOTAS } from "@/lib/messaging/service";
import { enforceSendLimits } from "@/lib/messaging/send-limits";
import { assertQuotas } from "@/lib/quota/gate";
import { assertLimit, consumeLimit } from "@/lib/rate-limit/limiter";
import { actOnAppointment } from "./service";

// POST /api/conversations/{cid}/appointment (architecture §5, 28 Oct): the messaging write path of
// handlers.ts for one appointment step. Members only, revocation checked, Origin + CSRF, a
// suspended account refused (it only reads); body, the appointment limiter then the thread's send
// limiter, the Firestore write quota gate, then the transaction.

type Params = Promise<Record<string, string | string[] | undefined>>;

const APPOINTMENT_BODY_MAX = 4 * 1024;

export async function handleAppointment(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true, checkRevoked: true });
  const parsed = cidSchema.safeParse((await params).cid);
  if (!parsed.success) throw notFound();
  const cid = parsed.data;
  const action = await readJson(request, appointmentActionSchema, APPOINTMENT_BODY_MAX);
  assertLimit("appointment.uid", await consumeLimit("appointment.uid", auth.user.uid));
  await enforceSendLimits(auth.user.uid, cid);
  await assertQuotas(MESSAGING_QUOTAS);
  const body: AppointmentResponse = await actOnAppointment({ uid: auth.user.uid, claims: auth.user.claims }, cid, action);
  return json(body, { status: 201 });
}
