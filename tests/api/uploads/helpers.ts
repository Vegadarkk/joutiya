import { NextRequest } from "next/server";
import { POST as createListing } from "@/app/api/listings/route";
import { PATCH as patchListing } from "@/app/api/listings/[id]/route";
import { POST as publishListing } from "@/app/api/listings/[id]/publish/route";
import type { CreateListingResponse, ListingPatch } from "@/lib/contracts/listings";
import { createAccountDocuments } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { setClaims, type Claims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sharp } from "@/lib/media/sharp-setup";
import { csrfToken } from "@/lib/security/csrf";
import { Jar, ORIGIN, type ErrorBody } from "../auth/helpers";
import { api as listingApi, attachPhoto, member, readyPatch, seedReadyUpload, THIRTY_DAYS_AGO, type Member } from "../listings/helpers";

// Plumbing of the uploads API tests: the listings helpers (members, drafts, ready uploads), a
// request builder for /api/uploads/** (the `[id]` param from the path), members with arbitrary
// claims (role matrix) and generated JPEG fixtures.

export { ORIGIN, attachPhoto, member, readyPatch, seedReadyUpload };
export type { ErrorBody, Member };

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
export type Handler = (request: NextRequest, context: RouteContext) => Promise<Response>;

export interface CallOptions {
  member?: Member;
  body?: unknown;
  /** null: no Origin header at all. */
  origin?: string | null;
  /** false: no X-CSRF-Token header even when the member has one. */
  csrf?: boolean;
}

export interface CallResult<T> {
  status: number;
  body: T;
  response: Response;
}

/** Calls an uploads route handler as the browser would; `[id]` is read from the path. */
export async function call<T = Record<string, unknown>>(handler: Handler, method: "GET" | "POST" | "DELETE", path: string, options: CallOptions = {}): Promise<CallResult<T>> {
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": options.member?.jar.ip ?? "10.98.0.1", "user-agent": "vitest" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const cookie = options.member?.jar.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = options.member?.jar.get("__Host-csrf");
  if (csrf && options.csrf !== false) headers.set("x-csrf-token", csrf);
  const id = /^\/api\/uploads\/([^/?]+)/.exec(path)?.[1];
  const params = id && id !== "sign" ? { id } : {};
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const response = await handler(request, { params: Promise.resolve(params) });
  const body = (response.status === 204 ? null : await response.json()) as T;
  return { status: response.status, body, response };
}

let counter = 0;
const run = Date.now().toString(36);

/** A member whose claims are exactly `claims` (null: no role, an unactivated account). */
export async function memberWithClaims(claims: Claims | null): Promise<Member> {
  counter += 1;
  const uid = `upl-${run}-${counter}`;
  const email = `${uid}@example.com`;
  await auth().createUser({ uid, email, emailVerified: true, password: ["Str0ng", "Passw0rd!"].join("-") });
  await createAccountDocuments({
    uid,
    email,
    displayName: "Karim Testeur",
    locale: "fr",
    consents: { cguVersion: "2026-10", transfersVersion: "2026-10", marketing: false },
    provider: "password",
    activated: claims !== null,
    now: THIRTY_DAYS_AGO(),
  });
  await setClaims(uid, claims);
  const minted = await createSessionForUid(uid);
  const jar = new Jar();
  jar.cookies.set("__Host-session", minted.cookie);
  jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return { uid, email, jar };
}

export async function draft(owner: Member, body: unknown = {}): Promise<string> {
  const created = await listingApi<CreateListingResponse>(createListing, "POST", "/api/listings", { member: owner, body });
  if (created.status !== 201) throw new Error(`draft creation failed: ${created.status}`);
  return created.body.id;
}

/** A published listing of `owner` with `photos` ready photos (seeded uploads). */
export async function publishedListing(owner: Member, photos = 1, overrides: Partial<ListingPatch> = {}): Promise<{ id: string; photoIds: string[] }> {
  const id = await draft(owner);
  const photoIds: string[] = [];
  for (let i = 0; i < photos; i += 1) photoIds.push(await seedReadyUpload(owner, id));
  const saved = await listingApi(patchListing, "PATCH", `/api/listings/${id}`, { member: owner, body: { ...readyPatch(overrides), photos: photoIds } });
  if (saved.status !== 200) throw new Error(`patch failed: ${saved.status}`);
  const published = await listingApi<{ status: string }>(publishListing, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  if (published.status !== 200 || published.body.status !== "published") throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
  return { id, photoIds };
}

export { listingApi, patchListing };

/** JPEG 100x50 with EXIF orientation 6 and GPS coordinates (the browser may send one). */
export async function exifGpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "Joutiya test", Model: "Fixture" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 35/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "7/1 36/1 0/1" },
    })
    .toBuffer();
}

export function plainJpeg(width = 120, height = 90): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 60 } } })
    .jpeg()
    .toBuffer();
}
