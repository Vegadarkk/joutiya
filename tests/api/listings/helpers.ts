import { NextRequest } from "next/server";
import { cityBySlug } from "@/config/regions";
import { COLLECTIONS, type UploadDoc } from "@/lib/db/schemas";
import { attachReadyPhoto } from "@/lib/db/repositories/listings";
import { createUpload, newUploadId } from "@/lib/db/repositories/uploads";
import { createAccountDocuments } from "@/lib/db/repositories/users";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { claimVerifiedPhone } from "@/lib/phone-verify/accounts";
import { csrfToken } from "@/lib/security/csrf";
import type { ListingPatch, ListingResponse, OwnerListing, PublishListingResponse } from "@/lib/contracts/listings";
import { Jar, ORIGIN, type ErrorBody } from "../auth/helpers";

// Plumbing of the listings API tests: members with a server-minted session (account age and
// verified phone on demand), a request builder for the /api/listings/** handlers (PATCH and
// DELETE, the `[id]` param from the path), ready uploads seeded through the repositories, and the
// wizard patch of a complete bicycle listing. Every test file mocks "@/lib/mail" itself.

export { Jar, ORIGIN };
export type { ErrorBody };

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
export type Handler = (request: NextRequest, context: RouteContext) => Promise<Response>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const THIRTY_DAYS_AGO = () => new Date(Date.now() - 30 * DAY_MS);

export interface Member {
  uid: string;
  email: string;
  jar: Jar;
}

export interface MemberOptions {
  /** Account creation date (users.createdAt); defaults to 30 days ago so no risk flag fires. */
  createdAt?: Date;
  /** false: Firebase user and badge unverified (the account stays `active`, the session valid). */
  emailVerified?: boolean;
  /** E.164 Moroccan mobile to mark as verified (`badges.phoneVerified`, private phoneE164). */
  phone?: string;
  displayName?: string;
}

let counter = 0;
const run = Date.now().toString(36);

export async function member(options: MemberOptions = {}): Promise<Member> {
  counter += 1;
  const uid = `lst-${run}-${counter}`;
  const email = `${uid}@example.com`;
  const emailVerified = options.emailVerified ?? true;
  await auth().createUser({ uid, email, emailVerified, password: ["Str0ng", "Passw0rd!"].join("-") });
  await createAccountDocuments({
    uid,
    email,
    displayName: options.displayName ?? "Salma Testeuse",
    locale: "fr",
    consents: { cguVersion: "2026-10", transfersVersion: "2026-10", marketing: false },
    provider: "password",
    activated: true,
    now: options.createdAt ?? THIRTY_DAYS_AGO(),
  });
  if (!emailVerified) await db().collection(COLLECTIONS.users).doc(uid).update({ "badges.emailVerified": false });
  if (options.phone) await claimVerifiedPhone(uid, options.phone);
  await setClaims(uid, { role: "individual" });
  const minted = await createSessionForUid(uid);
  const jar = new Jar();
  jar.cookies.set("__Host-session", minted.cookie);
  jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return { uid, email, jar };
}

/** A fresh valid Moroccan mobile for each use (a number verified in Firestore stays taken). */
const numberSeed = Date.now() % 10_000_000;
let numberCounter = 0;
export function freshPhone(): string {
  numberCounter += 1;
  return `+21261${String((numberSeed + numberCounter) % 10_000_000).padStart(7, "0")}`;
}

export interface ApiOptions {
  member?: Member;
  body?: unknown;
  /** null: no Origin header at all. */
  origin?: string | null;
  /** false: no X-CSRF-Token header even when the member has one. */
  csrf?: boolean;
  headers?: Record<string, string>;
  ip?: string;
  /** Route params when the path is not a /api/listings/{id} one. */
  params?: Record<string, string>;
}

export interface ApiResult<T> {
  status: number;
  body: T;
  response: Response;
  header(name: string): string | null;
}

/** Calls a route handler as the browser would; `[id]` is read from the path. */
export async function api<T = Record<string, unknown>>(handler: Handler, method: Method, path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": options.ip ?? options.member?.jar.ip ?? "10.99.0.1", "user-agent": "vitest" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const cookie = options.member?.jar.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = options.member?.jar.get("__Host-csrf");
  if (csrf && options.csrf !== false) headers.set("x-csrf-token", csrf);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const id = /^\/api\/listings\/([^/?]+)/.exec(path)?.[1];
  const params = options.params ?? (id && id !== "mine" ? { id } : {});
  const request = new NextRequest(`${ORIGIN}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const response = await handler(request, { params: Promise.resolve(params) });
  options.member?.jar.absorb(response);
  const body = (response.status === 204 ? null : await response.json()) as T;
  return { status: response.status, body, response, header: (name) => response.headers.get(name) };
}

// ---- Fixtures --------------------------------------------------------------------------------

const casablanca = cityBySlug("casablanca")!;

/** The wizard's patch of a complete bicycle listing in Casablanca (no phone shown). */
export function readyPatch(overrides: Partial<ListingPatch> = {}): ListingPatch {
  return {
    subcategoryId: "velos",
    title: "Vélo de ville Peugeot en bon état",
    description: "Vélo de ville 28 pouces, 6 vitesses, révisé récemment, deux pneus neufs. Remise en main propre à Casablanca.",
    attributes: { "bike-type": "ville", brand: "Peugeot" },
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: casablanca.regionCode, citySlug: casablanca.slug },
    contact: { showPhone: false, whatsapp: false },
    ...overrides,
  };
}

/** A `ready` upload document of `owner` for `listingId`, as the media pipeline leaves it. */
export async function seedReadyUpload(owner: Member, listingId: string, overrides: Partial<UploadDoc> = {}): Promise<string> {
  const id = newUploadId();
  const now = new Date();
  await createUpload(id, {
    ownerUid: owner.uid,
    purpose: "listing",
    targetId: listingId,
    declaredSize: 120_000,
    declaredType: "image/jpeg",
    status: "ready",
    quarantineKey: `quarantine/${listingId}/${id}`,
    finalKey: `listings/${listingId}/${id}`,
    bucket: "media",
    size: 118_000,
    width: 1600,
    height: 1200,
    blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    checks: { nsfw: 0.01, faces: 0 },
    variants: ["l", "s"],
    purgeAt: new Date(now.getTime() + 7 * DAY_MS),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

/** Attaches a ready photo the way the pipeline does (repository transaction). */
export async function attachPhoto(listingId: string, uploadId: string, maxPhotos = 10): Promise<void> {
  await attachReadyPhoto(listingId, { id: uploadId, w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }, { maxPhotos });
}

export type ListingBody = ListingResponse;
export type PublishBody = PublishListingResponse;
export type { OwnerListing };
