import { NextRequest } from "next/server";
import { POST as apply } from "@/app/api/pro/apply/route";
import type { ProApplyResponse } from "@/lib/contracts/pro";
import { createUpload, newUploadId } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { auth } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin } from "@/lib/security/origin";
import { DAY_MS, api, type ErrorBody, type Handler, type Member } from "../listings/helpers";

// Shared by the Pro API tests (phase 7): staff accounts on the admin host, KYBC piece fixtures
// and the application body.

const run = Date.now().toString(36);
let counter = 0;

export interface Staff {
  uid: string;
  email: string;
  session: string;
  csrf: string;
}

export const ADMIN_ORIGIN = () => expectedOrigin("admin");
export const ADMIN_HOST = () => new URL(ADMIN_ORIGIN()).host;

export async function staffAccount(role: Role): Promise<Staff> {
  counter += 1;
  const email = `pro-staff-${run}-${counter}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, displayName: `Staff ${counter}`, password: ["Porte", "Verte", "2026"].join("-") });
  await setClaims(record.uid, { role, v: 2 });
  const minted = await createSessionForUid(record.uid);
  return { uid: record.uid, email, session: minted.cookie, csrf: csrfToken(minted.cookie) };
}

export interface AdminOptions {
  /** Request on the public host instead of the admin one. */
  host?: string;
  /** Access identity e-mail header (defaults to the staff account's). */
  accessEmail?: string | null;
  /** No session cookie. */
  anonymous?: boolean;
  params?: Record<string, string>;
}

/** A back-office request: admin host, Access identity header, session and CSRF of `staff`. */
export async function adminRequest(handler: Handler, method: "GET" | "POST" | "DELETE", path: string, staff: Staff, body?: unknown, options: AdminOptions = {}): Promise<Response> {
  const host = options.host ?? ADMIN_HOST();
  const headers = new Headers({ host, "user-agent": "vitest", "x-forwarded-for": "10.78.0.1", origin: `http://${host}` });
  if (options.accessEmail !== null) headers.set("x-dev-access-email", options.accessEmail ?? staff.email);
  if (!options.anonymous) {
    headers.set("cookie", `__Host-session=${staff.session}`);
    headers.set("x-csrf-token", staff.csrf);
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const proId = /^\/api\/admin\/pros\/([^/?]+)/.exec(path)?.[1];
  const request = new NextRequest(`http://${host}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return handler(request, { params: Promise.resolve(options.params ?? (proId ? { proId } : {})) });
}

export async function admin<T>(handler: Handler, method: "GET" | "POST", path: string, staff: Staff, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await adminRequest(handler, method, path, staff, body);
  return { status: response.status, body: (await response.json()) as T };
}

export const code = (body: unknown) => (body as ErrorBody).error.code;

/** A `ready` KYBC piece of `owner` (private bucket), as the KYBC upload path leaves it. */
export async function kybPiece(owner: Member, overrides: { ownerUid?: string; purpose?: "kyb" | "listing"; declaredType?: "image/jpeg" | "image/png" | "application/pdf" } = {}): Promise<string> {
  const id = newUploadId();
  const now = new Date();
  await createUpload(id, {
    ownerUid: overrides.ownerUid ?? owner.uid,
    purpose: overrides.purpose ?? "kyb",
    targetId: owner.uid,
    declaredSize: 90_000,
    declaredType: overrides.declaredType ?? "image/jpeg",
    status: "ready",
    quarantineKey: `quarantine/kyb/${id}`,
    finalKey: `kyb/${owner.uid}/${id}`,
    bucket: "private",
    size: 90_000,
    checks: {},
    purgeAt: new Date(now.getTime() + 7 * DAY_MS),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export function application(pieces: string[], overrides: Record<string, unknown> = {}) {
  return {
    name: "Atlas Vélos",
    description: "Vente et réparation de vélos.",
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "auto_entrepreneur", ice: "001 234 567 000 089", aeNumber: "998877" },
    uploadIds: pieces,
    complianceCommitment: true,
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    ...overrides,
  };
}

/**
 * Runs `run` with the WhatsApp check configured (dummy credentials, like tests/api/phone): the Pro
 * gates then want a number verified beforehand. Without it (the default here, Meta app pending) a
 * moderator verifies the declared number by a call during the review.
 */
export async function withWhatsApp<T>(run: () => Promise<T>): Promise<T> {
  const values = { WHATSAPP_APP_SECRET: "api-test-app-secret", WHATSAPP_VERIFY_TOKEN: "api-test-verify-token", WHATSAPP_PHONE_NUMBER_ID: "100000000000001", WHATSAPP_DISPLAY_NUMBER: "212600000000" };
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  resetServerEnv();
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnv();
  }
}

export const applyAs = (owner: Member, body: unknown) => api<ProApplyResponse & ErrorBody>(apply, "POST", "/api/pro/apply", { member: owner, body });
