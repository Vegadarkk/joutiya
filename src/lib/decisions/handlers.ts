import "server-only";
import { requireSameOrigin, requireStaff, requireUser, type StaffContext } from "@/lib/auth/guards";
import { publicIdSchema } from "@/lib/db/schemas";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { parseTargetKey } from "@/lib/reports/target-key";
import { z } from "@/lib/zod";
import { appealLinkView, appealQueue, myDecisions, openAppealAsMember, openAppealByLink, reviewAppeal } from "./appeals";
import { createAuthorityRequest, getAuthorityRequest, authorityView, listAuthorityRequests, updateAuthorityRequest } from "./authorities";
import {
  AUTHORITY_STATUSES,
  bulkDismissSchema,
  createAuthorityRequestSchema,
  decideSchema,
  docIdSchema,
  linkAppealQuerySchema,
  linkAppealSchema,
  openAppealSchema,
  reviewAppealSchema,
  staffConversationQuerySchema,
  updateAuthorityRequestSchema,
  type AppealQueueResponse,
  type AppealableDecision,
  type AuthorityRequestView,
  type BulkDismissResponse,
  type CreateAuthorityResponse,
  type DecideResponse,
  type DecisionView,
  type ModerationStats,
  type MyDecisionsResponse,
  type OpenAppealResponse,
  type ResendNoticeResponse,
  type ReviewAppealResponse,
  type StaffConversationView,
  type UserModerationView,
} from "./contracts";
import { bulkDismiss, decide, type DecisionActor, type DecisionTarget } from "./decide";
import { resendDecisionNotice } from "./renotify";
import { getDecision } from "./repository";
import { staffConversation } from "./staff-conversations";
import { moderationStats } from "./stats";
import { uidByPublicId, userModerationView } from "./users";
import { decisionView } from "./views";

// Route handlers of the decisions lot (design D13-D18, D24). Back office: admin host only (Access
// + staff session; mutations same-origin + CSRF), moderators and admins, authority register admin
// only. Limiters: moderation.decision.uid for decisions and reviews (closed), admin.read.uid for
// reads (open), admin.conversation.uid for D18 openings (closed). Public appeals: appeal.uid for a
// signed-in account (suspended included), appeal.link.ip for the signed link. No quota gate: the
// decisions and appeals are legal duties, and they write a handful of documents.

type Params = { params: Promise<Record<string, string | string[] | undefined>> };

const STAFF = { roles: ["moderator", "admin"] as const };
const ADMIN = { roles: ["admin"] as const };

function queryOf<T>(request: Request, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    throw new HttpError(400, "invalid_body", undefined, { details });
  }
  return parsed.data;
}

async function param(context: Params, name: string, schema: z.ZodType<string>): Promise<string> {
  const parsed = schema.safeParse((await context.params)[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

const actorOf = (staff: StaffContext): DecisionActor & { role: "moderator" | "admin" } => ({ uid: staff.user.uid, role: staff.role });
const ipOf = (request: Request) => requestIdentity(request.headers).ip;

/** A decision target key from a validated body (decideSchema and bulkDismissSchema refused the others). */
function targetOf(key: string): DecisionTarget {
  const target = parseTargetKey(key);
  if (!target || target.type === "pro") throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "target", code: "invalid" }] });
  return { type: target.type, id: target.id };
}

// ---- Decisions ---------------------------------------------------------------------------------

/** POST /api/admin/decisions */
export async function handleDecide(request: Request): Promise<Response> {
  const staff = await requireStaff(request, { mutation: true, ...STAFF });
  await enforceLimit("moderation.decision.uid", staff.user.uid);
  const input = await readJson(request, decideSchema);
  const result = await decide(
    actorOf(staff),
    {
      target: targetOf(input.target),
      templateId: input.templateId,
      ...(input.details ? { details: input.details } : {}),
      ...(input.sanction ? { sanction: input.sanction } : {}),
      ...(input.manifestlyUnfounded ? { manifestlyUnfounded: input.manifestlyUnfounded } : {}),
      ...(input.ai ? { ai: input.ai } : {}),
    },
    { ip: ipOf(request) },
  );
  return json<DecideResponse>({ decisionId: result.decisionId, action: result.action, reportIds: result.reportIds, sanctionDecisionId: result.sanctionDecisionId }, { status: 201 });
}

/** GET /api/admin/decisions/{id} */
export async function handleDecisionGet(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, STAFF);
  const id = await param(context, "id", docIdSchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  const record = await getDecision(id);
  if (!record) throw notFound();
  return json<{ decision: DecisionView }>({ decision: decisionView(record) });
}

/** POST /api/admin/decisions/{id}/notify: the statement of reasons sent again (audit D1a-08). */
export async function handleResendNotice(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, { mutation: true, ...STAFF });
  const id = await param(context, "id", docIdSchema);
  await enforceLimit("moderation.decision.uid", staff.user.uid);
  return json<ResendNoticeResponse>(await resendDecisionNotice(actorOf(staff), id, { ip: ipOf(request) }));
}

/** POST /api/admin/decisions/bulk: P3 dismissals of up to 20 targets. */
export async function handleBulkDismiss(request: Request): Promise<Response> {
  const staff = await requireStaff(request, { mutation: true, ...STAFF });
  await enforceLimit("moderation.decision.uid", staff.user.uid);
  const input = await readJson(request, bulkDismissSchema);
  const results = await bulkDismiss(actorOf(staff), input.targets.map(targetOf), { ...(input.manifestlyUnfounded ? { manifestlyUnfounded: true } : {}), ip: ipOf(request) });
  return json<BulkDismissResponse>({ results });
}

// ---- Appeals (staff) ---------------------------------------------------------------------------

const appealQueueQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), after: z.string().min(1).max(200).optional() }).strict();

/** GET /api/admin/appeals: open appeals, oldest first. */
export async function handleAppealQueue(request: Request): Promise<Response> {
  const staff = await requireStaff(request, STAFF);
  const query = queryOf(request, appealQueueQuerySchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  return json<AppealQueueResponse>(await appealQueue(actorOf(staff), query));
}

/** POST /api/admin/appeals/{decisionId}: upheld or reversed by another moderator, or by an admin. */
export async function handleReviewAppeal(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, { mutation: true, ...STAFF });
  const decisionId = await param(context, "decisionId", docIdSchema);
  await enforceLimit("moderation.decision.uid", staff.user.uid);
  const input = await readJson(request, reviewAppealSchema);
  return json<ReviewAppealResponse>(await reviewAppeal(actorOf(staff), decisionId, input, { ip: ipOf(request) }));
}

// ---- Authority requests (admin) ----------------------------------------------------------------

const authorityListQuerySchema = z
  .object({ status: z.enum(AUTHORITY_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), after: z.string().min(1).max(200).optional() })
  .strict();

const adminActor = (staff: StaffContext) => ({ uid: staff.user.uid, role: "admin" as const });

/** GET /api/admin/authorities */
export async function handleAuthorityList(request: Request): Promise<Response> {
  const staff = await requireStaff(request, ADMIN);
  const query = queryOf(request, authorityListQuerySchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  return json<{ items: AuthorityRequestView[]; next: string | null }>(await listAuthorityRequests(query));
}

/** POST /api/admin/authorities */
export async function handleAuthorityCreate(request: Request): Promise<Response> {
  const staff = await requireStaff(request, { mutation: true, ...ADMIN });
  await enforceLimit("moderation.decision.uid", staff.user.uid);
  const input = await readJson(request, createAuthorityRequestSchema);
  return json<CreateAuthorityResponse>(await createAuthorityRequest(adminActor(staff), input, { ip: ipOf(request) }), { status: 201 });
}

/** GET /api/admin/authorities/{id} */
export async function handleAuthorityGet(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, ADMIN);
  const id = await param(context, "id", docIdSchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  const record = await getAuthorityRequest(id);
  if (!record) throw notFound();
  return json<{ request: AuthorityRequestView }>({ request: authorityView(record) });
}

/** PATCH /api/admin/authorities/{id}: answered or closed. */
export async function handleAuthorityUpdate(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, { mutation: true, ...ADMIN });
  const id = await param(context, "id", docIdSchema);
  await enforceLimit("moderation.decision.uid", staff.user.uid);
  const input = await readJson(request, updateAuthorityRequestSchema);
  return json<{ request: AuthorityRequestView }>({ request: await updateAuthorityRequest(adminActor(staff), id, input, { ip: ipOf(request) }) });
}

// ---- Accounts, stats, conversations (staff) ----------------------------------------------------

const uidSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const userLookupQuerySchema = z.object({ publicId: publicIdSchema }).strict();

/** GET /api/admin/users?publicId= */
export async function handleUserLookup(request: Request): Promise<Response> {
  const staff = await requireStaff(request, STAFF);
  const { publicId } = queryOf(request, userLookupQuerySchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  const uid = await uidByPublicId(publicId);
  const view = uid ? await userModerationView(uid) : null;
  if (!view) throw notFound();
  return json<{ user: UserModerationView }>({ user: view });
}

/** GET /api/admin/users/{uid} */
export async function handleUserGet(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, STAFF);
  const uid = await param(context, "uid", uidSchema);
  await enforceLimit("admin.read.uid", staff.user.uid);
  const view = await userModerationView(uid);
  if (!view) throw notFound();
  return json<{ user: UserModerationView }>({ user: view });
}

/** GET /api/admin/stats */
export async function handleStats(request: Request): Promise<Response> {
  const staff = await requireStaff(request, STAFF);
  await enforceLimit("admin.read.uid", staff.user.uid);
  return json<{ stats: ModerationStats }>({ stats: await moderationStats() });
}

/** GET /api/admin/conversations/{cid}?reason=: D18, audited. */
export async function handleStaffConversation(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, STAFF);
  const cid = await param(context, "cid", z.string().min(1).max(64));
  const { reason } = queryOf(request, staffConversationQuerySchema);
  await enforceLimit("admin.conversation.uid", staff.user.uid);
  const view = await staffConversation({ uid: staff.user.uid, role: staff.role }, cid, reason, { ip: ipOf(request) });
  return json<{ conversation: StaffConversationView }>({ conversation: view });
}

// ---- Appeals (public) --------------------------------------------------------------------------

/** GET /api/appeals: the decisions about the signed-in account. */
export async function handleMyDecisions(request: Request): Promise<Response> {
  const { user } = await requireUser(request, { allowSuspended: true });
  return json<MyDecisionsResponse>({ items: await myDecisions(user.uid) });
}

/** POST /api/appeals: signed-in appeal (affected account or notifier). */
export async function handleOpenAppeal(request: Request): Promise<Response> {
  const { user } = await requireUser(request, { mutation: true, allowSuspended: true });
  await enforceLimit("appeal.uid", user.uid);
  const input = await readJson(request, openAppealSchema);
  return json<OpenAppealResponse>(await openAppealAsMember(user.uid, input), { status: 201 });
}

function publicOrigin(request: Request, mutation: boolean): void {
  const host = mutation ? requireSameOrigin(request) : null;
  if (host !== null && host !== "public") throw notFound();
}

/** GET /api/appeals/link?token=: the decision the signed link names. */
export async function handleAppealLinkView(request: Request): Promise<Response> {
  publicOrigin(request, false);
  const { token } = queryOf(request, linkAppealQuerySchema);
  await enforceLimit("appeal.link.ip", requestIdentity(request.headers).ipBucket);
  return json<{ decision: AppealableDecision }>({ decision: await appealLinkView(token) });
}

/** POST /api/appeals/link: appeal through the signed link (banned accounts, notifiers without an account). */
export async function handleLinkAppeal(request: Request): Promise<Response> {
  publicOrigin(request, true);
  await enforceLimit("appeal.link.ip", requestIdentity(request.headers).ipBucket);
  const input = await readJson(request, linkAppealSchema);
  return json<OpenAppealResponse>(await openAppealByLink(input), { status: 201 });
}
