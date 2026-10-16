import { NextRequest } from "next/server";
import { expect, vi } from "vitest";
import { getListing, type ListingRecord } from "@/lib/db/repositories/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import type { DecisionRecord } from "@/lib/decisions/repository";
import { getDecision } from "@/lib/decisions/repository";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { TemplateId, TemplateMail } from "@/lib/mail/types";
import { getReport } from "@/lib/reports";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin } from "@/lib/security/origin";
import { Jar, ORIGIN, freshIp, type ErrorBody } from "../../auth/helpers";
import type { Handler, Member } from "../../listings/helpers";

// Plumbing of the decisions API tests (design D13-D18): staff accounts (Access e-mail + session +
// CSRF on the admin host), member calls on the public host, re-minted sessions (a sanction revokes
// the refresh tokens), the mails the "@/lib/mail" mock captured, and Firestore reads.

export type { ErrorBody, Member };

const run = Date.now().toString(36);
let counter = 0;

export interface Staff {
  uid: string;
  email: string;
  session: string;
}

export async function staff(role: Extract<Role, "moderator" | "admin">): Promise<Staff> {
  counter += 1;
  const email = `dec-${run}-${counter}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, displayName: `Staff ${counter}`, password: ["Porte", "Bleue", "2026"].join("-") });
  await setClaims(record.uid, { role, v: 2 });
  const minted = await createSessionForUid(record.uid);
  return { uid: record.uid, email, session: minted.cookie };
}

export interface Result<T> {
  status: number;
  body: T & ErrorBody;
}

interface CallOptions {
  body?: unknown;
  params?: Record<string, string>;
  ip?: string;
}

async function finish<T>(response: Response): Promise<Result<T>> {
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T & ErrorBody };
}

/** A back-office call (admin host, Access e-mail, session, CSRF). */
export async function adminCall<T>(handler: Handler, method: "GET" | "POST" | "PATCH", path: string, options: CallOptions & { as?: Staff; host?: string } = {}): Promise<Result<T>> {
  const adminOrigin = expectedOrigin("admin");
  const host = options.host ?? new URL(adminOrigin).host;
  const headers = new Headers({ host, "user-agent": "vitest", "x-forwarded-for": options.ip ?? "10.88.0.1", origin: adminOrigin });
  if (options.as) {
    headers.set("x-dev-access-email", options.as.email);
    headers.set("cookie", `__Host-session=${options.as.session}`);
    headers.set("x-csrf-token", csrfToken(options.as.session));
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new NextRequest(`http://${host}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  return finish<T>(await handler(request, { params: Promise.resolve(options.params ?? {}) }));
}

/** A public-host call, signed in (`as`) or not. */
export async function publicCall<T>(handler: Handler, method: "GET" | "POST", path: string, options: CallOptions & { as?: Member } = {}): Promise<Result<T>> {
  const jar = options.as?.jar;
  const headers = new Headers({ host: "localhost:3000", "user-agent": "vitest", "x-forwarded-for": options.ip ?? jar?.ip ?? freshIp(), origin: ORIGIN });
  const cookie = jar?.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar?.get("__Host-csrf");
  if (csrf) headers.set("x-csrf-token", csrf);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  jar?.absorb(response);
  return finish<T>(response);
}

/** A new session for a member whose tokens a sanction revoked. */
export async function resignIn(who: Member): Promise<Member> {
  const minted = await createSessionForUid(who.uid);
  const jar = new Jar(who.jar.ip);
  jar.cookies.set("__Host-session", minted.cookie);
  jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return { ...who, jar };
}

export function mailsOf(sendMail: unknown): TemplateMail[] {
  return vi.mocked(sendMail as (mail: TemplateMail) => Promise<void>).mock.calls.map(([mail]) => mail);
}

export function mailTo<T extends TemplateId>(sendMail: unknown, template: T, to: string): TemplateMail<T> | undefined {
  return mailsOf(sendMail)
    .filter((mail): mail is TemplateMail<T> => mail.template === template && mail.to === to)
    .at(-1);
}

export async function listing(id: string): Promise<ListingRecord> {
  const record = await getListing(id);
  expect(record).not.toBeNull();
  return record as ListingRecord;
}

export async function decision(id: string): Promise<DecisionRecord> {
  const record = await getDecision(id);
  expect(record).not.toBeNull();
  return record as DecisionRecord;
}

export async function reportStatus(id: string): Promise<{ status: string; outcome?: string; manifestlyUnfounded?: boolean; decisionId?: string }> {
  const record = await getReport(id);
  expect(record).not.toBeNull();
  return { status: record?.status ?? "", outcome: record?.outcome, manifestlyUnfounded: record?.manifestlyUnfounded, decisionId: record?.decisionId };
}

export async function userStatus(uid: string): Promise<string> {
  return String((await db().collection(COLLECTIONS.users).doc(uid).get()).get("status"));
}

export async function privateAccount(uid: string): Promise<Record<string, unknown>> {
  return (await db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc).get()).data() ?? {};
}

/** Audit entries of an action on a target id. */
export async function audits(action: string, targetId: string): Promise<Record<string, unknown>[]> {
  const snapshot = await db().collection(COLLECTIONS.auditLogs).where("action", "==", action).where("target.id", "==", targetId).get();
  return snapshot.docs.map((doc) => doc.data());
}
