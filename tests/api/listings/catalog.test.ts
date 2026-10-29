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
import { DELETE as deletePromo, PUT as putPromo } from "@/app/api/listings/[id]/promo/route";
import { PUT as putSection } from "@/app/api/listings/[id]/section/route";
import { PUT as putStock } from "@/app/api/listings/[id]/stock/route";
import { GET as mine } from "@/app/api/listings/mine/route";
import { PUT as putSections } from "@/app/api/pro/me/sections/route";
import type { ListingVariants, SectionsResponse } from "@/lib/contracts/catalog";
import type { CreateListingResponse, ListingPatch, OwnerListingsResponse, OwnerRowResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { lastMail } from "../auth/helpers";
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

describe("Pro catalogue: promotions", () => {
  const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  type PromoBody = OwnerRowResponse & ErrorBody;

  async function publishedShirt(owner: Member, extra: Partial<ListingPatch> = { variants: undefined }): Promise<string> {
    const { id, saved } = await shirtDraft(owner, extra);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const published = await api<PublishBody & ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
    expect(published.body.status, JSON.stringify(published.body)).toBe("published");
    return id;
  }

  it("runs one promotion at a time, then waits 7 days after it ends", async () => {
    const owner = await shop();
    const id = await publishedShirt(owner);
    const set = await api<PromoBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: owner, body: { kind: "promo", endsAt: inHours(72), percent: 20 } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.listing.status).toBe("published");
    // Published today: no struck-out price yet (art. 54 needs 30 days of history).
    expect(set.body.listing.catalogue?.promo).toMatchObject({ kind: "promo", prices: [{ key: "", price: 200, reference: null }] });
    expect((await getListing(id))?.promo).toMatchObject({ kind: "promo", percent: 20 });

    const again = await api<PromoBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: owner, body: { kind: "flash", endsAt: inHours(24), percent: 10 } });
    expect(again.status).toBe(400);
    expect(again.body.error.details).toEqual([{ path: "promo", code: "promo_exists" }]);

    const ended = await api<PromoBody>(deletePromo, "DELETE", `/api/listings/${id}/promo`, { member: owner });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.listing.catalogue?.promo).toBeNull();
    const stored = (await getListing(id))!;
    expect(stored.promo ?? null).toBeNull();
    expect(stored.lastPromoEndedAt).toBeInstanceOf(Date);

    const soon = await api<PromoBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: owner, body: { kind: "promo", endsAt: inHours(72), percent: 20 } });
    expect(soon.status).toBe(400);
    expect(soon.body.error.details).toEqual([{ path: "startsAt", code: "promo_gap", value: expect.any(String) }]);
  });

  it("ends the promotion on a price change", async () => {
    const owner = await shop();
    const id = await publishedShirt(owner);
    await api(putPromo, "PUT", `/api/listings/${id}/promo`, { member: owner, body: { kind: "soldes", endsAt: inHours(48), price: 199 } });
    expect((await getListing(id))?.promo?.prices).toEqual([{ key: "", price: 199, reference: null }]);
    const cheaper = await api<ListingBody & ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: 240 } });
    expect(cheaper.status, JSON.stringify(cheaper.body)).toBe(200);
    expect((await getListing(id))?.promo ?? null).toBeNull();
  });

  it("holds a cut deeper than 70 % for a moderator, with the statement mailed", async () => {
    vi.mocked(sendMail).mockClear();
    const owner = await shop();
    const id = await publishedShirt(owner, {});
    const deep = await api<PromoBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: owner, body: { kind: "flash", endsAt: inHours(24), percent: 80 } });
    expect(deep.status, JSON.stringify(deep.body)).toBe(200);
    expect(deep.body.listing.status).toBe("pending_review");
    expect(deep.body.listing.catalogue?.promo?.prices.map((entry) => entry.price)).toEqual([50, 58, 50]);
    const stored = (await getListing(id))!;
    expect(stored.moderation).toMatchObject({ state: "needs_review", flags: expect.arrayContaining(["promo_check"]) });
    expect(stored.adsEligible).toBe(false);
    expect(lastMail(sendMail, "listingPendingReview", owner.email)?.data).toMatchObject({ listingId: id });
  });

  it("keeps promotions for Pros, on a live listing", async () => {
    const seller = await member();
    const { id } = await shirtDraft(seller, { variants: undefined });
    const draft = await api<ErrorBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: seller, body: { kind: "promo", endsAt: inHours(72), percent: 20 } });
    expect(draft.status).toBe(409);
    await api(publish, "POST", `/api/listings/${id}/publish`, { member: seller, body: { acceptRules: true } });
    const individual = await api<ErrorBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: seller, body: { kind: "promo", endsAt: inHours(72), percent: 20 } });
    expect(individual.status).toBe(400);
    expect(individual.body.error.details).toEqual([{ path: "promo", code: "promo_pro_only" }]);
    const both = await api<ErrorBody>(putPromo, "PUT", `/api/listings/${id}/promo`, { member: seller, body: { kind: "promo", endsAt: inHours(72), percent: 20, price: 100 } });
    expect(both.status).toBe(400);
  });
});

describe("Pro catalogue: shop sections", () => {
  type SectionsBody = SectionsResponse & ErrorBody;
  const save = (owner: Member, sections: { id?: string; name: string }[]) => api<SectionsBody>(putSections, "PUT", "/api/pro/me/sections", { member: owner, body: { sections } });

  it("keeps the ids of the sections it knows, adds new ones and refuses a contact in a name", async () => {
    const owner = await shop();
    const first = await save(owner, [{ name: "Ramadan" }, { name: "Rentrée" }]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const [ramadan, rentree] = first.body.sections;
    expect(ramadan).toMatchObject({ id: expect.stringMatching(/^[a-z0-9]{6}$/), name: "Ramadan" });

    const second = await save(owner, [{ id: rentree!.id, name: "Rentrée scolaire" }, { id: "zzzzzz", name: "Mariage" }]);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.sections[0]).toEqual({ id: rentree!.id, name: "Rentrée scolaire" });
    expect(second.body.sections[1]?.id).not.toBe("zzzzzz");
    expect(second.body.sections.map((section) => section.id)).not.toContain(ramadan!.id);

    const contact = await save(owner, [{ name: "Appelez le 0612345678" }]);
    expect(contact.status).toBe(422);
    const duplicate = await save(owner, [{ name: "Mariage" }, { name: "mariage" }]);
    expect(duplicate.status).toBe(400);

    const cleared = await save(owner, []);
    expect(cleared.body.sections).toEqual([]);
    const stored = (await db().collection(COLLECTIONS.users).doc(owner.uid).get()).data() as { proId: string };
    expect((await proProfileRef(stored.proId).get()).data()?.sections).toBeUndefined();
  });

  it("puts a listing in a section of its shop, lists the sections with the rows and refuses others", async () => {
    const owner = await shop();
    const { sections } = (await save(owner, [{ name: "Ramadan" }])).body;
    const { id } = await shirtDraft(owner, { variants: undefined });

    const unknown = await api<OwnerRowResponse & ErrorBody>(putSection, "PUT", `/api/listings/${id}/section`, { member: owner, body: { sectionId: "abc123" } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([{ path: "sectionId", code: "section_unknown" }]);

    const set = await api<OwnerRowResponse & ErrorBody>(putSection, "PUT", `/api/listings/${id}/section`, { member: owner, body: { sectionId: sections[0]!.id } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.listing.sectionId).toBe(sections[0]!.id);
    expect((await getListing(id))?.sectionId).toBe(sections[0]!.id);

    const rows = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine", { member: owner });
    expect(rows.status).toBe(200);
    expect(rows.body.sections).toEqual(sections);

    const out = await api<OwnerRowResponse & ErrorBody>(putSection, "PUT", `/api/listings/${id}/section`, { member: owner, body: { sectionId: null } });
    expect(out.status).toBe(200);
    expect((await getListing(id))?.sectionId ?? null).toBeNull();
  });

  it("keeps sections for Pros", async () => {
    const seller = await member();
    const { id } = await shirtDraft(seller, { variants: undefined });
    const individual = await api<ErrorBody>(putSection, "PUT", `/api/listings/${id}/section`, { member: seller, body: { sectionId: "abc123" } });
    expect(individual.status).toBe(400);
    expect(individual.body.error.details).toEqual([{ path: "sectionId", code: "section_pro_only" }]);
    const settings = await save(seller, [{ name: "Ramadan" }]);
    expect(settings.status).toBe(409);
  });
});
