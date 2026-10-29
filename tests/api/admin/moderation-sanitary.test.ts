import { randomInt } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Produits du terroir against the Firebase emulators: a shop's first listing with an ONSSA number
// waits for a moderator (flag sanitary_check); the approval records the number on the shop, so the
// next listing with it publishes at once, while a new number is held again.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { DEFAULT_PRICING } from "@/config/pricing";
import { cityBySlug } from "@/config/regions";
import { GET as getReview, POST as postDecision } from "@/app/api/admin/moderation/[id]/route";
import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { ModerationReview } from "@/lib/listings/moderation-actions";
import type { ModerationDecisionResponse } from "@/lib/moderation/decisions";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin } from "@/lib/security/origin";
import { api, member, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "../listings/helpers";

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const run = Date.now().toString(36);
const essaouira = cityBySlug("essaouira")!;

interface Staff {
  email: string;
  session: string;
  csrf: string;
}

let moderator: Staff;
let ADMIN_ORIGIN = "";

beforeAll(async () => {
  resetServerEnv();
  ADMIN_ORIGIN = expectedOrigin("admin");
  const email = `mod-sanitary-${run}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, displayName: "Staff ONSSA", password: ["Porte", "Bleue", "2026"].join("-") });
  await setClaims(record.uid, { role: "moderator", v: 2 });
  const minted = await createSessionForUid(record.uid);
  moderator = { email, session: minted.cookie, csrf: csrfToken(minted.cookie) };
});
beforeEach(() => resetRateLimiters());

async function admin<T>(handler: (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>, method: "GET" | "POST", id: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers = new Headers({ host: new URL(ADMIN_ORIGIN).host, origin: ADMIN_ORIGIN, "user-agent": "vitest", "x-forwarded-for": "10.77.0.2", "x-dev-access-email": moderator.email, cookie: `__Host-session=${moderator.session}`, "x-csrf-token": moderator.csrf });
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new NextRequest(`${ADMIN_ORIGIN}/api/admin/moderation/${id}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await handler(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as T };
}

/** A verified cooperative on the launch offer, signed in as its owner. */
async function cooperative(): Promise<{ owner: Member; proId: string }> {
  const owner = await member({ displayName: "Coopérative Tifawt" });
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Coopérative Tifawt",
    slug: `tifawt-${proId}`,
    description: "Huile d'argan, huile d'olive et miel.",
    whatsapp: false,
    regionCode: essaouira.regionCode,
    citySlug: essaouira.slug,
    legal: { form: "cooperative", ice: "001234567000089", coopNumber: "12/2019" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "essentiel",
    planSource: "launch_offer",
    quotas: DEFAULT_PRICING.pro.essentiel,
    createdAt: now,
    updatedAt: now,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await db().collection(COLLECTIONS.users).doc(owner.uid).update({ type: "pro", proId });
  await setClaims(owner.uid, { role: "pro", proId, proRole: "owner" });
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return { owner, proId };
}

/** Publishes a honey listing with `number`; returns its id and the publish status. */
async function honey(owner: Member, number: string, title = "Miel de thym d'Essaouira, pot de 500 g"): Promise<{ id: string; status: string }> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  const photo = await seedReadyUpload(owner, id);
  const saved = await api<ListingBody & ErrorBody>(patch, "PATCH", `/api/listings/${id}`, {
    member: owner,
    body: {
      subcategoryId: "miel",
      title,
      description: "Miel de thym récolté cet été par nos apicultrices, pot en verre de 500 g, non chauffé.",
      attributes: { "onssa-number": number, "honey-type": "thym" },
      price: 220,
      priceNegotiable: false,
      isDonation: false,
      location: { regionCode: essaouira.regionCode, citySlug: essaouira.slug },
      contact: { showPhone: false, whatsapp: false },
      photos: [photo],
    },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await api<PublishBody & ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { id, status: published.body.status };
}

describe("ONSSA number of a food listing", () => {
  it("holds the shop's first use of a number, records it on approval, then lets it through", async () => {
    const { owner, proId } = await cooperative();
    const first = await honey(owner, "M.07.113.20");
    expect(first.status).toBe("pending_review");
    expect((await getListing(first.id))?.moderation.flags).toContain("sanitary_check");

    const review = await admin<{ review: ModerationReview }>(getReview, "GET", first.id);
    expect(review.status).toBe(200);
    expect(review.body.review.screening?.evidence).toContain("ONSSA number M.07.113.20 not yet checked for this shop");

    const version = (await getListing(first.id))!.version;
    const approved = await admin<ModerationDecisionResponse>(postDecision, "POST", first.id, { action: "approve", version });
    expect(approved.status).toBe(200);
    expect((await getProProfile(proId))?.sanitaryNumbers).toEqual(["M.07.113.20"]);

    const second = await honey(owner, "M.07.113.20", "Miel de thym, pot de 1 kg");
    expect(second.status).toBe("published");
    expect((await getListing(second.id))?.moderation.flags).not.toContain("sanitary_check");

    const other = await honey(owner, "M.07.200.24", "Miel d'euphorbe, pot de 500 g");
    expect(other.status).toBe("pending_review");
    expect((await getListing(other.id))?.moderation.flags).toContain("sanitary_check");
  });

  it("does not record a number when the moderator rejects the listing", async () => {
    const { owner, proId } = await cooperative();
    const held = await honey(owner, "M.07.300.25");
    const version = (await getListing(held.id))!.version;
    const rejected = await admin<ModerationDecisionResponse & ErrorBody>(postDecision, "POST", held.id, { action: "reject", version, reason: "other", details: "Numéro ONSSA absent des listes publiées." });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await getProProfile(proId))?.sanitaryNumbers).toBeUndefined();
  });
});
