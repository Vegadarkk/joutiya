import "server-only";
import type { RateLimitId } from "@/config/rate-limits";
import { REPORT_PRIORITIES } from "@/config/report-reasons";
import { LOCALES, type Locale } from "@/config/site";
import { anonymous, beginAnonymous, checkTurnstile, respond } from "@/lib/auth/anonymous";
import { requireStaff, requireUser } from "@/lib/auth/guards";
import { createReportSchema } from "@/lib/contracts/reports";
import { REPORT_STATUSES } from "@/lib/db/schemas";
import { readCookie } from "@/lib/http/cookies";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { escalateOnIp } from "@/lib/listings/escalation";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { assertLimit, consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { SESSION_COOKIE } from "@/lib/security/cookies";
import { z } from "@/lib/zod";
import { listQueue, QUEUE_LIMIT_DEFAULT, QUEUE_LIMIT_MAX, reportTargetView, type ReportQueueResponse, type ReportTargetView } from "./admin";
import { assertReportInput, createReport } from "./service";
import { parseTargetKey } from "./target-key";

// Route handlers of the reports (design D10, D24).
// POST /api/reports: visitors (listings and profiles, Turnstile always, name and e-mail unless P0)
// and members (session + CSRF; suspended accounts may report; Turnstile past the IP allowance).
// Limiters before any Firestore read: report.uid (members) or report.device + report.ip (visitors);
// P0 reasons add report.p0.*. Open policies: a report is always accepted, but a P0 counted without
// the store gets no "multi" strong signal (D11). No quota gate: reports stay open when Firestore
// writes are degraded (src/config/quotas.ts).
// GET /api/admin/reports and /api/admin/reports/target: moderators and admins, admin host only.

/** The language of a visitor's acknowledgement: the NEXT_LOCALE cookie, else the page that sent the form, else French. */
export function visitorLocale(headers: Headers): Locale {
  const isLocale = (value: string | undefined): value is Locale => value !== undefined && (LOCALES as readonly string[]).includes(value);
  const cookie = readCookie(headers, "NEXT_LOCALE");
  if (isLocale(cookie)) return cookie;
  const referer = headers.get("referer");
  if (referer) {
    try {
      const segment = new URL(referer).pathname.split("/")[1];
      if (isLocale(segment)) return segment;
    } catch {
      // Malformed Referer: the default.
    }
  }
  return "fr";
}

/** consume + assert; false when the store could not count (open policy let the request through). */
async function counted(id: RateLimitId, key: string): Promise<boolean> {
  const outcome = await consumeLimit(id, key);
  assertLimit(id, outcome);
  return outcome.ok;
}

async function create(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  // A session cookie makes it a member's report (a stale one answers 401: the form signs in again).
  const member = readCookie(request.headers, SESSION_COOKIE) ? await requireUser(request, { mutation: true, allowSuspended: true }) : null;
  const input = await readJson(request, createReportSchema);
  const priority = assertReportInput(input, member !== null);
  const { identity } = flow;

  if (member) await enforceLimit("report.uid", member.user.uid);
  else {
    await enforceLimit("report.device", identity.deviceKey);
    await enforceLimit("report.ip", identity.ipBucket);
  }
  let allCounted = true;
  if (priority === "P0") {
    if (member) allCounted = (await counted("report.p0.uid", member.user.uid)) && allCounted;
    allCounted = (await counted("report.p0.device", identity.deviceKey)) && allCounted;
    allCounted = (await counted("report.p0.ip", identity.ipBucket)) && allCounted;
  }
  if (member) {
    if (await escalateOnIp(request, "report.ip", flow.device, input.turnstileToken, "report")) flow.turnstilePassed = true;
  } else {
    await checkTurnstile(flow, input.turnstileToken, "report");
  }

  const result = await createReport(
    input,
    { uid: member?.user.uid ?? null, ip: identity.ip, deviceKey: identity.deviceKey, locale: visitorLocale(request.headers) },
    { multiSignal: allCounted },
  );
  return respond(flow, result.response, { status: result.created ? 201 : 200 });
}

/** POST /api/reports (device and Turnstile pass cookies on every answer, errors included). */
export const handleCreateReport = anonymous(create);

const queueQuerySchema = z
  .object({
    priority: z.enum(REPORT_PRIORITIES).optional(),
    status: z.enum(REPORT_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(QUEUE_LIMIT_MAX).optional(),
    after: z.string().min(1).max(200).optional(),
  })
  .strict();

function queryOf<T>(request: Request, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    throw new HttpError(400, "invalid_body", undefined, { details });
  }
  return parsed.data;
}

/** GET /api/admin/reports?status=&priority=&limit=&after=: a page of a queue (D24). */
export async function handleQueue(request: Request): Promise<Response> {
  const staff = await requireStaff(request, { roles: ["moderator", "admin"] });
  const query = queryOf(request, queueQuerySchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  const body = await listQueue({
    limit: query.limit ?? QUEUE_LIMIT_DEFAULT,
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.after ? { after: query.after } : {}),
  });
  return json<ReportQueueResponse>(body);
}

const targetQuerySchema = z.object({ key: z.string().min(3).max(160) }).strict();

/** GET /api/admin/reports/target?key={type}:{id}: the target view with its history (D24). */
export async function handleTargetView(request: Request): Promise<Response> {
  const staff = await requireStaff(request, { roles: ["moderator", "admin"] });
  const { key } = queryOf(request, targetQuerySchema);
  if (!parseTargetKey(key)) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "key", code: "invalid_value" }] });
  await enforceLimit("admin.read.uid", staff.user.uid);
  const view = await reportTargetView(key, staff, requestIdentity(request.headers));
  if (!view) throw notFound();
  return json<{ view: ReportTargetView }>({ view });
}
