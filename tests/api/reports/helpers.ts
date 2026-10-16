import { NextRequest } from "next/server";
import { expect } from "vitest";
import { POST as createListing } from "@/app/api/listings/route";
import { PATCH as patchListing } from "@/app/api/listings/[id]/route";
import { POST as publishListing } from "@/app/api/listings/[id]/publish/route";
import { POST as postReport } from "@/app/api/reports/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { CreateReportResponse } from "@/lib/contracts/reports";
import { COLLECTIONS, type UploadDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { newDeviceCookie } from "@/lib/security/device";
import { Jar, ORIGIN, freshIp, type ErrorBody } from "../auth/helpers";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ListingBody, type Member, type MemberOptions, type PublishBody } from "../listings/helpers";

// Plumbing of the reports API tests: published listings (one fresh seller each, so the duplicate
// screening never holds them), visitors with their own device cookie and IP, members, the POST
// /api/reports call, and conversations seeded straight into Firestore (messaging is another lot).

export { DAY_MS, Jar, ORIGIN, member };
export type { ErrorBody, Member, MemberOptions };

export type ReportBody = CreateReportResponse & ErrorBody;

/** A visitor: no session, a device cookie (set by the proxy on any page view) and its own IP. */
export function visitor(ip = freshIp()): Jar {
  const jar = new Jar(ip);
  jar.cookies.set("__Host-did", newDeviceCookie().value);
  return jar;
}

export interface ReportCall {
  /** Member (session + CSRF) or visitor jar. */
  as?: Member | Jar;
  origin?: string | null;
  csrf?: boolean;
  headers?: Record<string, string>;
}

/** POST /api/reports as the browser would. */
export async function report(body: unknown, options: ReportCall = {}): Promise<{ status: number; body: ReportBody; response: Response }> {
  const jar = options.as instanceof Jar ? options.as : options.as?.jar;
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": jar?.ip ?? freshIp(), "user-agent": "vitest", "content-type": "application/json" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  const cookie = jar?.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar?.get("__Host-csrf");
  if (csrf && options.csrf !== false) headers.set("x-csrf-token", csrf);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const request = new NextRequest(`${ORIGIN}/api/reports`, { method: "POST", headers, body: JSON.stringify(body) });
  const response = await postReport(request, { params: Promise.resolve({}) });
  jar?.absorb(response);
  return { status: response.status, body: (await response.json()) as ReportBody, response };
}

export const EXPLANATION = "Le vendeur demande une avance par Wafacash avant de montrer l'objet.";

/** A notice body for a listing. */
export function listingNotice(id: string, reasonId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { target: { type: "listing", id }, reasonId, explanation: EXPLANATION, goodFaith: true, turnstileToken: "tok", ...extra };
}

let sellerCounter = 0;

/** A published listing of a fresh seller with one ready photo; `checks` overrides the photo's local model scores. */
export async function publishedListing(options: { seller?: Member; checks?: UploadDoc["checks"] } = {}): Promise<{ id: string; seller: Member; uploadId: string }> {
  sellerCounter += 1;
  const seller = options.seller ?? (await member({ displayName: `Vendeur ${String.fromCharCode(65 + (sellerCounter % 26))}` }));
  const created = await api<CreateListingResponse>(createListing, "POST", "/api/listings", { member: seller, body: {} });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const uploadId = await seedReadyUpload(seller, id, options.checks ? { checks: options.checks } : {});
  const saved = await api<ListingBody>(patchListing, "PATCH", `/api/listings/${id}`, { member: seller, body: { ...readyPatch(), photos: [uploadId] } });
  expect(saved.status).toBe(200);
  const published = await api<PublishBody>(publishListing, "POST", `/api/listings/${id}/publish`, { member: seller, body: { acceptRules: true } });
  expect(published.body.status).toBe("published");
  return { id, seller, uploadId };
}

/** users/{uid}.publicId of a member. */
export async function publicIdOf(uid: string): Promise<string> {
  return String((await db().collection(COLLECTIONS.users).doc(uid).get()).get("publicId"));
}

/** Makes `who` a trusted reporter (D11): account of 60 days, verified phone, 5 founded reports. */
export async function makeTrusted(who: Member): Promise<void> {
  const users = db().collection(COLLECTIONS.users).doc(who.uid);
  await users.update({ "badges.phoneVerified": true, createdAt: new Date(Date.now() - 60 * DAY_MS) });
  await users.collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc).update({ reporter: { recent: [true, true, true, true, true], total: 5 } });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let idCounter = 0;
function randomId(length: number, alphabet = B64): string {
  idCounter += 1;
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out.slice(0, length - 2) + String(idCounter % 100).padStart(2, "0");
}

/**
 * A conversation about `listingId` between `buyer` and `seller` with one text message from
 * `sender`, written straight into Firestore in the shape of conversationSchema / messageSchema.
 */
export async function seedConversation(listingId: string, buyer: Member, seller: Member, sender: Member, text = "Envoyez l'acompte par Wafacash."): Promise<{ cid: string; mid: string }> {
  const cid = randomId(22);
  const mid = randomId(20);
  const now = new Date();
  const ref = db().collection(COLLECTIONS.conversations).doc(cid);
  await ref.set({
    listingId,
    listingSlugId: `velo-de-ville-${listingId}`,
    sellerUid: seller.uid,
    buyerUid: buyer.uid,
    participants: [buyer.uid, seller.uid],
    sellerName: "Vendeur",
    sellerPublicId: await publicIdOf(seller.uid),
    buyerName: "Acheteur",
    buyerPublicId: await publicIdOf(buyer.uid),
    listingSnapshot: { title: "Vélo de ville", price: 1500, isDonation: false, photo: null },
    lastMessage: { preview: text.slice(0, 140), senderUid: sender.uid, at: now, flagged: true },
    unread: { [buyer.uid]: 0, [seller.uid]: 1 },
    blockedBy: [],
    archivedBy: [],
    hiddenFor: [],
    status: "open",
    messageCount: 1,
    createdAt: now,
    updatedAt: now,
    purgeAt: new Date(now.getTime() + 365 * DAY_MS),
    legalHold: [],
  });
  await ref.collection(COLLECTIONS.messages).doc(mid).set({ senderUid: sender.uid, participants: [buyer.uid, seller.uid], type: "text", text, createdAt: now });
  return { cid, mid };
}
