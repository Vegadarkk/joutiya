import { randomInt } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Car rental listings (rental pack, design location-voitures/location-voitures.md §2) against the
// Firebase emulators: Pro agencies only, the licence reference in the agency's settings and its
// attestation at every publication, the day price and long-term rates, and the moderator review
// of a rental "with driver".

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { PUT as putAvailability } from "@/app/api/listings/[id]/availability/route";
import { GET as getFleet, PUT as putFleet } from "@/app/api/pro/fleet/route";
import { GET as getMe } from "@/app/api/pro/me/route";
import { PUT as putRental } from "@/app/api/pro/me/rental/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { CreateListingResponse, FieldIssue, FleetResponse, FleetSaveResponse, RentalAvailabilityResponse } from "@/lib/contracts/listings";
import type { ProMeResponse, ProRentalResponse } from "@/lib/contracts/pro";
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

const SETTINGS = {
  agrementRef: "AGR 123/2025",
  branches: [{ citySlug: "marrakech", address: "Avenue Mohammed VI, Guéliz" }],
  hours: "Tous les jours de 8 h à 21 h",
  payments: ["cash", "card"],
  airports: ["rak"],
};

/** A verified rental agency on the launch offer, signed in as its owner; `settings: false` before it filled its settings. */
async function agency({ settings = true }: { settings?: boolean } = {}): Promise<Member> {
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
      sector: "car_rental",
      ...(settings ? { rental: { ...SETTINGS, payments: ["cash", "card"] as const, airports: ["rak"] as const } } : {}),
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

  it("needs the licence reference in the agency's settings first", async () => {
    const owner = await agency({ settings: false });
    const id = await rentalDraft(owner);
    const missing = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("rental_agrement_missing");

    const saved = await api<ProRentalResponse>(putRental, "PUT", "/api/pro/me/rental", { member: owner, body: SETTINGS });
    expect(saved.status).toBe(200);
    expect(saved.body.rental).toEqual(SETTINGS);
    expect((await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } })).body.status).toBe("published");
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

describe("fleet planning", () => {
  const day = (offset: number) => dayString(moroccoToday(new Date()) + offset);
  const fleet = (owner: Member) => api<FleetResponse & ErrorBody>(getFleet, "GET", "/api/pro/fleet", { member: owner });
  const save = (owner: Member, body: unknown) => api<FleetSaveResponse & ErrorBody>(putFleet, "PUT", "/api/pro/fleet", { member: owner, body });
  const published = async (owner: Member, title: string) => {
    const id = await rentalDraft(owner, { title });
    expect((await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, rentalAttestation: true } })).body.status).toBe("published");
    return id;
  };

  it("lists the agency's rentals on offer by title and saves each change with its own lock", async () => {
    const owner = await agency();
    const logan = await published(owner, "Dacia Logan diesel à Marrakech");
    const clio = await published(owner, "Clio 5 essence à Marrakech");
    await rentalDraft(owner, { title: "Brouillon de location Duster" });
    const listed = await fleet(owner);
    expect(listed.status).toBe(200);
    expect(listed.body.truncated).toBe(false);
    expect(listed.body.vehicles.map((vehicle) => vehicle.id)).toEqual([clio, logan]);
    expect(listed.body.vehicles[0]?.rental).toEqual({ unavailable: [], updatedAt: null });

    const saved = await save(owner, {
      changes: [
        { id: logan, unavailable: [{ from: day(2), to: day(4) }], since: null },
        { id: clio, unavailable: [], since: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.results).toEqual([
      { id: logan, rental: { unavailable: [{ from: day(2), to: day(4) }], updatedAt: expect.any(String) } },
      { id: clio, error: "conflict" },
    ]);
    expect((await getListing(logan))?.rental?.unavailable).toEqual([{ from: day(2), to: day(4) }]);
    expect((await getListing(clio))?.rental).toBeUndefined();

    // Another agency's rental is not found; its planning stays its own.
    const stranger = await agency();
    expect((await save(stranger, { changes: [{ id: logan, unavailable: [], since: null }] })).body.results).toEqual([{ id: logan, error: "not_found" }]);
    expect((await fleet(stranger)).body.vehicles).toEqual([]);
  });

  it("is for Pro accounts only", async () => {
    const someone = await member();
    expect((await api<ErrorBody>(putRental, "PUT", "/api/pro/me/rental", { member: someone, body: SETTINGS })).status).toBe(409);
    expect((await fleet(someone)).status).toBe(403);
    expect((await save(someone, { changes: [{ id: "abcdefgh", unavailable: [], since: null }] })).status).toBe(403);
  });
});

describe("car rental agency settings", () => {
  const put = (owner: Member, body: unknown) => api<ProRentalResponse & ErrorBody>(putRental, "PUT", "/api/pro/me/rental", { member: owner, body });

  it("replaces the settings, read back in the Pro area", async () => {
    const owner = await agency({ settings: false });
    const next = { ...SETTINGS, branches: [...SETTINGS.branches, { citySlug: "agadir", address: "Boulevard du 20 Août, Founty" }], airports: ["rak", "aga"] };
    expect((await put(owner, next)).status).toBe(200);
    const me = await api<ProMeResponse>(getMe, "GET", "/api/pro/me", { member: owner });
    expect(me.body.shop).toMatchObject({ sector: "car_rental", rental: next });
    expect((await put(owner, { ...next, branches: [], hours: "", payments: [], airports: [] })).body.rental).toMatchObject({ branches: [], airports: [] });
  });

  it("refuses a malformed reference, unknown airports, duplicates and contact details in the texts", async () => {
    const owner = await agency({ settings: false });
    for (const body of [
      { ...SETTINGS, agrementRef: "AB" },
      { ...SETTINGS, agrementRef: "sans chiffre" },
      { ...SETTINGS, airports: ["cdg"] },
      { ...SETTINGS, payments: ["cash", "cash"] },
      { ...SETTINGS, branches: [SETTINGS.branches[0], SETTINGS.branches[0]] },
      { ...SETTINGS, extra: true },
    ]) {
      expect((await put(owner, body)).status, JSON.stringify(body)).toBe(400);
    }
    const phone = await put(owner, { ...SETTINGS, hours: "Appelez le 0612345678" });
    expect(phone.status).toBe(422);
    expect(phone.body.error.code).toBe("invalid_text");
    expect((await put(owner, { ...SETTINGS, branches: [{ citySlug: "marrakech", address: "contact@agence.ma, Guéliz" }] })).status).toBe(422);
  });
});
