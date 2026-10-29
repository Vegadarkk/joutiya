import { randomInt } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pro catalogue, lot 4 PR 1 (catalogue-boutique.md §2-4) against the Firebase emulators: a shop
// lists a shirt in sizes and colours, the size axis answers the required size, the publication
// starts the price history, a price change adds a point, the stock is set alone without a new
// screening, and an individual is refused variants and stock (owner decision 5).

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { DEFAULT_PRICING } from "@/config/pricing";
import { cityBySlug } from "@/config/regions";
import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { PUT as putStock } from "@/app/api/listings/[id]/stock/route";
import type { ListingVariants } from "@/lib/contracts/catalog";
import type { CreateListingResponse, ListingPatch } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, member, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "./helpers";

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const casablanca = cityBySlug("casablanca")!;

const VARIANTS: ListingVariants = {
  axes: [
    { id: "clothing-size", values: ["s", "m", "l"] },
    { id: "color", values: ["bleu", "noir"] },
  ],
  items: [
    { key: "s|bleu", stock: 4 },
    { key: "m|bleu", stock: 2, price: 290 },
    { key: "l|noir", stock: 0, ref: "CHM-L-N" },
  ],
};

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

/** A verified shop on the launch offer, signed in as its owner. */
async function shop(): Promise<Member> {
  const owner = await member({ displayName: "Atelier Nour" });
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Atelier Nour",
    slug: `atelier-nour-${proId}`,
    description: "Chemises brodées main à Fès.",
    whatsapp: false,
    regionCode: casablanca.regionCode,
    citySlug: casablanca.slug,
    legal: { form: "societe", ice: "001234567000089", rc: "123456", if: "7654321" },
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
  return owner;
}

async function shirtDraft(owner: Member, extra: Partial<ListingPatch> = {}): Promise<{ id: string; saved: { status: number; body: ListingBody & ErrorBody } }> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  const photo = await seedReadyUpload(owner, id);
  const saved = await api<ListingBody & ErrorBody>(patch, "PATCH", `/api/listings/${id}`, {
    member: owner,
    body: {
      subcategoryId: "vetements",
      title: "Chemise en lin brodée main",
      description: "Chemise en lin lavé, broderie faite main à Fès, coupe droite, plusieurs tailles et couleurs.",
      attributes: { audience: "homme", "clothing-type": "haut", "clothing-size": "m" },
      condition: "new_tagged",
      price: 250,
      priceNegotiable: false,
      isDonation: false,
      location: { regionCode: casablanca.regionCode, citySlug: casablanca.slug },
      contact: { showPhone: false, whatsapp: false },
      photos: [photo],
      variants: VARIANTS,
      ...extra,
    },
  });
  return { id, saved };
}

describe("Pro catalogue: variants and stock", () => {
  it("publishes a shirt in sizes, starts the price history and records a price change", async () => {
    const owner = await shop();
    const { id, saved } = await shirtDraft(owner);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // The size axis takes over the size criterion: its attribute goes.
    expect(saved.body.listing.attributes).toEqual({ audience: "homme", "clothing-type": "haut" });
    expect(saved.body.listing.variants).toEqual(VARIANTS);
    expect(saved.body.listing.stock).toBeNull();

    const published = await api<PublishBody & ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.status).toBe("published");
    const live = (await getListing(id))!;
    expect(live.priceLog?.map((point) => [point.key, point.price])).toEqual([
      ["s|bleu", 250],
      ["m|bleu", 290],
      ["l|noir", 250],
    ]);

    const cheaper = await api<ListingBody & ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: 230 } });
    expect(cheaper.status, JSON.stringify(cheaper.body)).toBe(200);
    const after = (await getListing(id))!;
    expect(after.priceLog?.slice(3).map((point) => [point.key, point.price])).toEqual([
      ["s|bleu", 230],
      ["l|noir", 230],
    ]);
  });

  it("sets the stock alone, without a new screening, and refuses what the listing does not hold", async () => {
    const owner = await shop();
    const { id } = await shirtDraft(owner);
    await api(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
    const before = (await getListing(id))!;

    const updated = await api<ListingBody & ErrorBody>(putStock, "PUT", `/api/listings/${id}/stock`, { member: owner, body: { items: [{ key: "l|noir", stock: 7 }, { key: "s|bleu", stock: null }] } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.listing.variants?.items).toEqual([
      { key: "s|bleu" },
      { key: "m|bleu", stock: 2, price: 290 },
      { key: "l|noir", stock: 7, ref: "CHM-L-N" },
    ]);
    const after = (await getListing(id))!;
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("published");
    expect(after.moderation).toEqual(before.moderation);
    expect(after.priceLog).toEqual(before.priceLog);

    const unknown = await api<ErrorBody>(putStock, "PUT", `/api/listings/${id}/stock`, { member: owner, body: { items: [{ key: "xl|bleu", stock: 1 }] } });
    expect(unknown.status).toBe(400);
    const whole = await api<ErrorBody>(putStock, "PUT", `/api/listings/${id}/stock`, { member: owner, body: { stock: 3 } });
    expect(whole.status).toBe(400);
    const stranger = await member();
    const foreign = await api<ErrorBody>(putStock, "PUT", `/api/listings/${id}/stock`, { member: stranger, body: { items: [{ key: "l|noir", stock: 0 }] } });
    expect(foreign.status).toBe(404);
  });

  it("keeps the listing's own stock without variants, and drops it when variants come", async () => {
    const owner = await shop();
    const { id, saved } = await shirtDraft(owner, { variants: undefined, stock: 12 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.listing.stock).toBe(12);
    const sold = await api<ListingBody & ErrorBody>(putStock, "PUT", `/api/listings/${id}/stock`, { member: owner, body: { stock: 0 } });
    expect(sold.body.listing.stock).toBe(0);
    const both = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { variants: VARIANTS, stock: 3 } });
    expect(both.status).toBe(400);
    const withVariants = await api<ListingBody & ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { variants: VARIANTS } });
    expect(withVariants.status, JSON.stringify(withVariants.body)).toBe(200);
    expect(withVariants.body.listing.stock).toBeNull();
    expect((await getListing(id))?.stock).toBeUndefined();
  });

  it("refuses variants and stock to an individual (owner decision 5)", async () => {
    const seller = await member();
    const { id, saved } = await shirtDraft(seller);
    expect(saved.status).toBe(400);
    expect(saved.body.error.details).toEqual([{ path: "variants", code: "variants_pro_only" }]);
    const stock = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: seller, body: { stock: 2 } });
    expect(stock.status).toBe(400);
    const put = await api<ErrorBody>(putStock, "PUT", `/api/listings/${id}/stock`, { member: seller, body: { stock: 2 } });
    expect(put.status).toBe(400);
  });
});
