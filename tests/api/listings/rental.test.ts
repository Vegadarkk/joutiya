import { randomInt } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Car rental listings (rental pack, design location-voitures/location-voitures.md §2) against the
// Firebase emulators: Pro agencies only, the agency's attestation at every publication, the day
// price and long-term rates, and the moderator review of a rental "with driver".

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { PUT as putAvailability } from "@/app/api/listings/[id]/availability/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { CreateListingResponse, FieldIssue, RentalAvailabilityResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { dayString, moroccoToday } from "@/lib/listings/rental-availability";
import { proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, attachPhoto, member, readyPatch, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const ACCEPT = { acceptRules: true };
const codesOf = (issues: FieldIssue[]) => issues.map((issue) => `${issue.path}:${issue.code}`);

/** A verified rental agency on the launch offer, signed in as its owner. */
async function agency(): Promise<Member> {
  const owner = await member({ displayName: "Océan Rent" });
  const proId = newProId();
  const now = new Date();
  await proProfileRef(proId).set(
    proProfileToFirestore({
      ownerUid: owner.uid,
      members: { [owner.uid]: "owner" },
      name: "Océan Rent",
      slug: `ocean-rent-${proId}`,
      description: "Location de voitures récentes à Marrakech.",
      whatsapp: false,
      regionCode: "07",
      citySlug: "marrakech",
      legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
      kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
      lifecycle: "verified",
      plan: "essentiel",
      planSource: "launch_offer",
      quotas: DEFAULT_PRICING.pro.essentiel,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await db().collection(COLLECTIONS.users).doc(owner.uid).update({ type: "pro", proId });
  await setClaims(owner.uid, { role: "pro", proId, proRole: "owner" });
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return owner;
}

const RENTAL = {
  categoryId: "vehicules",
  subcategoryId: "location-voitures",
  title: "Dacia Logan ou similaire à Marrakech",
  description: "Berline diesel climatisée, kilométrage illimité, remise à l'aéroport Marrakech Menara, tarif dégressif dès 7 jours.",
  attributes: { "rental-class": "berline", "car-brand": "dacia", model: "Logan", gearbox: "manuelle", fuel: "diesel", "mileage-policy": "illimite", "rental-deposit": 5000, "rate-7-days": 260 },
  price: 300,
  condition: null,
};

async function rentalDraft(owner: Member, overrides: Parameters<typeof readyPatch>[0] = {}): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const saved = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ ...RENTAL, ...overrides }) });
  expect(saved.status).toBe(200);
  const first = await seedReadyUpload(owner, id);
  const second = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [first] } })).status).toBe(200);
  await attachPhoto(id, second);
  return id;
}

describe("car rental publication", () => {
  it("needs the agency's attestation, then publishes", async () => {
    const owner = await agency();
    const id = await rentalDraft(owner);
    const missing = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("rental_attestation");
    expect((await getListing(id))?.status).toBe("draft");

    const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("published");
  });

  it("refuses a long-term rate above the day price, and holds a rental with driver for a moderator", async () => {
    const owner = await agency();
    const dear = await rentalDraft(owner, { attributes: { ...RENTAL.attributes, "rate-7-days": 350 } });
    const refused = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${dear}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } });
    expect(refused.status).toBe(422);
    expect(codesOf(refused.body.error.details)).toEqual(["attributes.rate-7-days:rental_rate_max"]);

    const driven = await rentalDraft(owner, { description: "Berline confortable, location avec chauffeur pour vos mariages et transferts aéroport, tarif à la journée." });
    const held = await api<PublishBody>(publish, "POST", `/api/listings/${driven}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ status: "pending_review", flags: ["rental_review"] });
  });
});

describe("car rental availability", () => {
  const day = (offset: number) => dayString(moroccoToday(new Date()) + offset);
  const put = (owner: Member, id: string, body: unknown) => api<RentalAvailabilityResponse & ErrorBody & { error: { details?: FieldIssue[] } }>(putAvailability, "PUT", `/api/listings/${id}/availability`, { member: owner, body });

  it("stores merged periods, re-indexes a published rental and refuses a stale calendar", async () => {
    const owner = await agency();
    const id = await rentalDraft(owner);
    expect((await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } })).body.status).toBe("published");
    const before = (await getListing(id))?.version ?? 0;

    const saved = await put(owner, id, {
      unavailable: [
        { from: day(5), to: day(8) },
        { from: day(9), to: day(10) },
        { from: day(-4), to: day(-1) },
      ],
      since: null,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.rental.unavailable).toEqual([{ from: day(5), to: day(10) }]);
    const stored = await getListing(id);
    expect(stored?.rental?.unavailable).toEqual([{ from: day(5), to: day(10) }]);
    expect(stored?.version).toBe(before + 1);
    expect((await getSearchOutbox(id))?.version).toBe(before + 1);

    // A calendar opened before that save is refused; the current one confirms unchanged days.
    expect((await put(owner, id, { unavailable: [], since: null })).status).toBe(409);
    const confirmed = await put(owner, id, { unavailable: saved.body.rental.unavailable, since: saved.body.rental.updatedAt });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.rental.unavailable).toEqual([{ from: day(5), to: day(10) }]);
  });

  it("refuses days past the horizon, another member's rental and a listing that is not a rental", async () => {
    const owner = await agency();
    const id = await rentalDraft(owner);
    const far = await put(owner, id, { unavailable: [{ from: day(10), to: day(400) }], since: null });
    expect(far.status).toBe(422);
    expect(far.body.error.details).toEqual([{ path: "unavailable", code: "too_far" }]);
    expect((await put(owner, id, { unavailable: [{ from: day(3), to: day(1) }], since: null })).status).toBe(422);

    const stranger = await agency();
    expect((await put(stranger, id, { unavailable: [], since: null })).status).toBe(404);

    const bike = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
    await api<ListingBody>(patch, "PATCH", `/api/listings/${bike.body.id}`, { member: owner, body: readyPatch() });
    const refused = await put(owner, bike.body.id, { unavailable: [], since: null });
    expect(refused.status).toBe(409);
  });
});
