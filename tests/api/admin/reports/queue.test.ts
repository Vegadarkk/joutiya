import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Back-office report reads (design D24) against the Firebase emulators: the queue (priority then due
// date, filters, pages, groups by target) and the target view (open reports and history, reporters'
// accuracy, the listing or message, the agent's proposal). Staff only, admin host only; reporters'
// contact details never leave the server; reading a reported message is journaled.

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { GET as getQueue } from "@/app/api/admin/reports/route";
import { GET as getTarget } from "@/app/api/admin/reports/target/route";
import { slaDueAt, type ReportPriority } from "@/config/report-reasons";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, aiDecisionSchema, reportSchema, type ReportDoc } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import * as limiter from "@/lib/rate-limit/limiter";
import type { ReportQueueResponse, ReportTargetView } from "@/lib/reports";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin } from "@/lib/security/origin";
import { EXPLANATION, listingNotice, member, publishedListing, report, seedConversation, visitor, type ErrorBody } from "../../reports/helpers";

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
type Handler = (request: NextRequest, context: RouteContext) => Promise<Response>;

const run = Date.now().toString(36);
let counter = 0;
let ADMIN_ORIGIN = "";
let ADMIN_HOST = "";
let PUBLIC_HOST = "";

interface Staff {
  uid: string;
  email: string;
  session: string;
}

async function account(role: Role): Promise<Staff> {
  counter += 1;
  const email = `rep-${run}-${counter}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, displayName: `Staff ${counter}`, password: ["Porte", "Bleue", "2026"].join("-") });
  await setClaims(record.uid, { role, v: 2 });
  const minted = await createSessionForUid(record.uid);
  return { uid: record.uid, email, session: minted.cookie };
}

async function admin<T>(handler: Handler, path: string, options: { staff?: Staff; host?: string; access?: string } = {}): Promise<{ status: number; body: T & ErrorBody }> {
  const host = options.host ?? ADMIN_HOST;
  const headers = new Headers({ host, "user-agent": "vitest", "x-forwarded-for": "10.77.0.1", origin: ADMIN_ORIGIN });
  const access = options.access ?? options.staff?.email;
  if (access) headers.set("x-dev-access-email", access);
  if (options.staff) {
    headers.set("cookie", `__Host-session=${options.staff.session}`);
    headers.set("x-csrf-token", csrfToken(options.staff.session));
  }
  const response = await handler(new NextRequest(`http://${host}${path}`, { method: "GET", headers }), { params: Promise.resolve({}) });
  return { status: response.status, body: (await response.json()) as T & ErrorBody };
}

const HOUR = 3_600_000;
let seeded = 0;

/** A report written straight into Firestore (the queue reads documents, whoever wrote them). */
async function seedReport(priority: ReportPriority, options: { createdAt?: Date; status?: ReportDoc["status"]; targetId?: string; reasonId?: ReportDoc["reasonId"] } = {}): Promise<string> {
  seeded += 1;
  const createdAt = options.createdAt ?? new Date();
  const doc = reportSchema.parse({
    target: { type: "user", id: options.targetId ?? `seed-${run}-${seeded}`, ownerUid: options.targetId ?? `seed-${run}-${seeded}` },
    reasonId: options.reasonId ?? ({ P0: "threat", P1: "scam", P2: "harassment", P3: "spam" } as const)[priority],
    priority,
    explanation: `${EXPLANATION} (${seeded})`,
    goodFaith: true,
    source: "user",
    reporter: { name: "Visiteur Secret", email: "secret.visitor@example.com", locale: "fr", ipPrefixHash: "h-ip", deviceHash: "h-dev", trusted: false },
    hidden: false,
    status: options.status ?? "open",
    slaDueAt: slaDueAt(priority, createdAt),
    createdAt,
    updatedAt: createdAt,
    purgeAt: new Date(createdAt.getTime() + 5 * 365 * 24 * HOUR),
  });
  const ref = db().collection(COLLECTIONS.reports).doc();
  await ref.set(datesToTimestamps(doc));
  return ref.id;
}

let moderator: Staff;
let adminStaff: Staff;
let individual: Staff;

beforeAll(async () => {
  resetServerEnv();
  ADMIN_ORIGIN = expectedOrigin("admin");
  ADMIN_HOST = new URL(ADMIN_ORIGIN).host;
  PUBLIC_HOST = new URL(expectedOrigin("public")).host;
  moderator = await account("moderator");
  adminStaff = await account("admin");
  individual = await account("individual");
  // The queue is global: start from an empty collection (test files run one at a time).
  const existing = await db().collection(COLLECTIONS.reports).get();
  for (const doc of existing.docs) await doc.ref.delete();
});

beforeEach(() => {
  limiter.resetRateLimiters();
});

describe("access", () => {
  it("answers 404 on the public host, 401 without a session, 403 for a member or a foreign Access identity", async () => {
    for (const [handler, path] of [
      [getQueue, "/api/admin/reports"],
      [getTarget, "/api/admin/reports/target?key=listing:abcd2345"],
    ] as const) {
      expect((await admin(handler, path, { staff: moderator, host: PUBLIC_HOST })).status).toBe(404);
      expect((await admin(handler, path, { access: moderator.email })).status).toBe(401);
      expect((await admin(handler, path, { staff: individual })).status).toBe(403);
      expect((await admin(handler, path, { staff: moderator, access: adminStaff.email })).status).toBe(403);
    }
  });
});

describe("queue", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const now = Date.now();
    ids.p3 = await seedReport("P3", { createdAt: new Date(now - 2 * HOUR) });
    ids.p1Late = await seedReport("P1", { createdAt: new Date(now - 30 * HOUR) });
    ids.p1 = await seedReport("P1", { createdAt: new Date(now - HOUR) });
    ids.p0 = await seedReport("P0", { createdAt: new Date(now - 10 * 60_000) });
    ids.grouped = await seedReport("P3", { createdAt: new Date(now - 3 * HOUR), targetId: `seed-${run}-group` });
    ids.groupedP1 = await seedReport("P1", { createdAt: new Date(now - 3 * HOUR), targetId: `seed-${run}-group` });
    ids.actioned = await seedReport("P2", { createdAt: new Date(now - 5 * HOUR), status: "actioned" });
  });

  it("orders the open reports by priority then due date, flags the overdue ones, groups by target", async () => {
    const vectors = [moderator, adminStaff];
    for (const staff of vectors) {
      const result = await admin<ReportQueueResponse>(getQueue, "/api/admin/reports", { staff });
      expect(result.status).toBe(200);
      expect(result.body.items.map((item) => item.id)).toEqual([ids.p0, ids.p1Late, ids.groupedP1, ids.p1, ids.grouped, ids.p3]);
      expect(result.body.items.find((item) => item.id === ids.p1Late)).toMatchObject({ overdue: true, priority: "P1", reporter: { kind: "visitor", trusted: false } });
      expect(result.body.items.find((item) => item.id === ids.p0)?.overdue).toBe(false);
      const group = result.body.groups.find((entry) => entry.targetKey === `user:seed-${run}-group`);
      expect(group).toMatchObject({ priority: "P1", reportIds: [ids.groupedP1, ids.grouped] });
      expect(result.body.next).toBeNull();
      // Reporters' contact details stay on the server.
      expect(JSON.stringify(result.body)).not.toMatch(/secret\.visitor|Visiteur Secret|h-ip|h-dev/);
    }
    expect(vi.mocked(limiter.enforceLimit)).toHaveBeenCalledWith("admin.read.uid", adminStaff.uid);
  });

  it("filters by priority and pages with an opaque cursor", async () => {
    const p1 = await admin<ReportQueueResponse>(getQueue, "/api/admin/reports?priority=P1", { staff: moderator });
    expect(p1.body.items.map((item) => item.id)).toEqual([ids.p1Late, ids.groupedP1, ids.p1]);

    const first = await admin<ReportQueueResponse>(getQueue, "/api/admin/reports?limit=2", { staff: moderator });
    expect(first.body.items.map((item) => item.id)).toEqual([ids.p0, ids.p1Late]);
    expect(first.body.next).toEqual(expect.any(String));
    const second = await admin<ReportQueueResponse>(getQueue, `/api/admin/reports?limit=2&after=${encodeURIComponent(first.body.next!)}`, { staff: moderator });
    expect(second.body.items.map((item) => item.id)).toEqual([ids.groupedP1, ids.p1]);
    const filtered = await admin<ReportQueueResponse>(getQueue, "/api/admin/reports?priority=P1&limit=1", { staff: moderator });
    const rest = await admin<ReportQueueResponse>(getQueue, `/api/admin/reports?priority=P1&limit=5&after=${encodeURIComponent(filtered.body.next!)}`, { staff: moderator });
    expect(rest.body.items.map((item) => item.id)).toEqual([ids.groupedP1, ids.p1]);
  });

  it("lists closed reports newest first, and refuses bad parameters (400)", async () => {
    const closed = await admin<ReportQueueResponse>(getQueue, "/api/admin/reports?status=actioned", { staff: moderator });
    expect(closed.body.items.map((item) => item.id)).toEqual([ids.actioned]);
    for (const query of ["status=actioned&priority=P2", "after=not-a-cursor", "limit=0", "limit=500", "priority=P9", "sort=asc"]) {
      const result = await admin(getQueue, `/api/admin/reports?${query}`, { staff: moderator });
      expect(result.status, query).toBe(400);
      expect(result.body.error.code).toBe("invalid_body");
    }
  });
});

describe("target view", () => {
  it("shows a listing's open reports with the reporters' accuracy, the listing, the owner and the agent's proposal", async () => {
    const { id, seller } = await publishedListing();
    const reporterMember = await member();
    const byMember = await report(listingNotice(id, "scam"), { as: reporterMember });
    const byVisitor = await report(listingNotice(id, "misleading", { name: "Nadia Visiteuse", email: "nadia.cachee@example.com" }), { as: visitor() });
    expect([byMember.status, byVisitor.status]).toEqual([201, 201]);
    await db()
      .collection(COLLECTIONS.users)
      .doc(reporterMember.uid)
      .collection(COLLECTIONS.userPrivate)
      .doc(COLLECTIONS.userPrivateDoc)
      .update({ reporter: { recent: [true, true, false, true], total: 6 } });
    const now = new Date();
    const ai = await db()
      .collection(COLLECTIONS.aiDecisions)
      .add(
        datesToTimestamps(
          aiDecisionSchema.parse({
            task: "report_triage",
            target: { type: "report", id: byMember.body.reportId },
            provider: "rules",
            model: "rules",
            promptVersion: "triage-v1",
            output: { action: "escalate", policy: "scam", severity: "P1", confidence: 0.7, rationale: "Demande d'avance.", templateId: "listing_remove_scam" },
            applied: "pending",
            costMicroUsd: 0,
            inputHash: "h",
            createdAt: now,
            purgeAt: new Date(now.getTime() + 365 * 24 * HOUR),
            legalHold: [],
          }),
        ),
      );
    await db().collection(COLLECTIONS.reports).doc(byMember.body.reportId).update({ aiDecisionId: ai.id });

    const result = await admin<{ view: ReportTargetView }>(getTarget, `/api/admin/reports/target?key=listing:${id}`, { staff: moderator });
    expect(result.status).toBe(200);
    const { view } = result.body;
    expect(view.targetKey).toBe(`listing:${id}`);
    expect(view.open.map((item) => item.id)).toEqual([byMember.body.reportId, byVisitor.body.reportId]);
    const memberReport = view.open[0]!;
    expect(memberReport).toMatchObject({ explanation: EXPLANATION, reporter: { kind: "account" }, reporterAccuracy: { decided: 4, founded: 3, share: 0.75, total: 6, abusiveUntil: null } });
    expect(view.open[1]).toMatchObject({ reporter: { kind: "visitor" }, reporterContact: { name: true, email: true }, reporterAccuracy: null });
    expect(view.snapshot).toMatchObject({ type: "listing", id, title: expect.any(String), status: "published", moderation: { openReports: 2, hiddenBy: null } });
    expect(view.owner).toMatchObject({ uid: seller.uid, status: "active", strikes: 0 });
    expect(view.history).toEqual([]);
    expect(view.decisions).toEqual([]);
    expect(view.ai).toMatchObject({ id: ai.id, action: "escalate", policy: "scam", confidence: 0.7, templateId: "listing_remove_scam", applied: "pending" });
    expect(JSON.stringify(view)).not.toMatch(/nadia\.cachee|Nadia Visiteuse|ipPrefixHash|deviceHash/);
  });

  it("shows a reported message alone and journals the read", async () => {
    const { id, seller } = await publishedListing();
    const buyer = await member();
    const { cid, mid } = await seedConversation(id, buyer, seller, seller, "Paie d'abord par ⟦url⟧");
    await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.evidence).doc(mid).set({ text: "Paie d'abord par https://pay.example", flags: ["external_url"], reason: "masked", createdAt: new Date() });
    const filed = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "scam", explanation: EXPLANATION, goodFaith: true }, { as: buyer });
    expect(filed.status).toBe(201);
    const result = await admin<{ view: ReportTargetView }>(getTarget, `/api/admin/reports/target?key=${encodeURIComponent(`message:${cid}/${mid}`)}`, { staff: moderator });
    expect(result.status).toBe(200);
    expect(result.body.view.snapshot).toMatchObject({ type: "message", cid, mid, listingId: id, text: "Paie d'abord par ⟦url⟧", original: "Paie d'abord par https://pay.example", hidden: false, sender: "seller" });
    expect(result.body.view.owner?.uid).toBe(seller.uid);
    const audit = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", `${cid}/${mid}`).get();
    expect(audit.docs.map((doc) => doc.data())).toEqual([expect.objectContaining({ action: "message.read", actorUid: moderator.uid, automated: false })]);
  });

  it("answers 404 for an unknown target and 400 for a malformed key", async () => {
    expect((await admin(getTarget, "/api/admin/reports/target?key=listing:zzzz2345", { staff: moderator })).status).toBe(404);
    for (const key of ["listing:ABC", "nope:1", "listing", ""]) {
      expect((await admin(getTarget, `/api/admin/reports/target?key=${encodeURIComponent(key)}`, { staff: moderator })).status, key).toBe(400);
    }
    expect((await admin(getTarget, "/api/admin/reports/target", { staff: moderator })).status).toBe(400);
  });
});
