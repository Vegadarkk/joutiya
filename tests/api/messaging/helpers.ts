import { expect } from "vitest";
import { MESSAGING_API } from "@/lib/contracts/endpoints";
import type { SendMessageResponse, StartConversationResponse } from "@/lib/contracts/messaging";
import { listingRef, toFirestore } from "@/lib/db/repositories/listings";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { newUploadId } from "@/lib/db/repositories/uploads";
import type { ListingDoc } from "@/lib/db/schemas";
import { newListingId } from "@/lib/listings/ids";
import { POST as startRoute } from "@/app/api/conversations/route";
import { POST as sendRoute } from "@/app/api/conversations/[cid]/messages/route";
import { POST as readRoute } from "@/app/api/conversations/[cid]/read/route";
import { POST as stateRoute } from "@/app/api/conversations/[cid]/state/route";
import { GET as unreadRoute } from "@/app/api/messages/unread/route";
import { call, type CallOptions, type CallResult, type ErrorBody, type Member } from "../favorites/helpers";

// Plumbing of the messaging API tests (lot L1): published listings written straight to Firestore,
// and one call helper per route. Members come from ../listings/helpers (server-minted sessions);
// each test file mocks Turnstile and installs the fake Valkey itself.

export { expectError, member, spend, type ErrorBody, type Member } from "../favorites/helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A published listing of `owner`, as publish() leaves it (one photo, Casablanca). */
export async function seedListing(owner: Member, overrides: Partial<ListingDoc> = {}): Promise<{ id: string; slugId: string }> {
  const id = newListingId();
  const slugId = `velo-de-ville-casablanca-${id}`;
  const account = await getUserRecord(owner.uid);
  if (!account) throw new Error("seedListing: owner has no account document");
  const now = new Date();
  const doc: ListingDoc = {
    ownerUid: owner.uid,
    sellerType: "individual",
    sellerName: account.displayName,
    sellerPublicId: account.publicId,
    status: "published",
    slugId,
    title: "Vélo de ville Peugeot",
    description: "Vélo de ville 28 pouces, 6 vitesses, révisé récemment. Remise en main propre à Casablanca.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: {},
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [{ id: newUploadId(), w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: now,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: true,
    publishedAt: now,
    expiresAt: new Date(now.getTime() + 60 * DAY_MS),
    legalHold: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
  await listingRef(id).set(toFirestore(doc));
  return { id, slugId };
}

type Body<T> = T & ErrorBody;

export function start(who: Member | undefined, body: unknown, options: Omit<CallOptions, "member" | "body"> = {}): Promise<CallResult<Body<StartConversationResponse>>> {
  return call(startRoute, "POST", MESSAGING_API.conversations, { member: who, body, ...options });
}

/** First message about `listingId` with a valid Turnstile token (the mock accepts any but "bad"). */
export async function startOk(who: Member, listingId: string, text = "Bonjour, toujours disponible ?"): Promise<StartConversationResponse> {
  const result = await start(who, { listingId, text, turnstileToken: "ok" });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}

export function send(who: Member | undefined, cid: string, text: string, options: Omit<CallOptions, "member" | "body" | "params"> = {}): Promise<CallResult<Body<SendMessageResponse>>> {
  return call(sendRoute, "POST", MESSAGING_API.messages(cid), { member: who, body: { text }, params: { cid }, ...options });
}

export function markRead(who: Member | undefined, cid: string, options: Omit<CallOptions, "member" | "params"> = {}): Promise<CallResult<ErrorBody | null>> {
  return call(readRoute, "POST", MESSAGING_API.read(cid), { member: who, params: { cid }, ...options });
}

export function setState(who: Member | undefined, cid: string, body: unknown): Promise<CallResult<ErrorBody | null>> {
  return call(stateRoute, "POST", MESSAGING_API.state(cid), { member: who, params: { cid }, body });
}

export function unread(who: Member | undefined): Promise<CallResult<Body<{ total: number }>>> {
  return call(unreadRoute, "GET", MESSAGING_API.unread, { member: who });
}
