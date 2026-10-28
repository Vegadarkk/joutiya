import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Publication (architecture §7, design D8) against the emulators: the happy path (published,
// slugId, url, searchOutbox, contentOps, mail), the 422 blockers (readiness and pre-moderation),
// the hold to pending_review with its statement, the 5-per-day limiter and the IP escalation.

// Search fast lane off: these tests read the searchOutbox entries it would drain (phase 4).
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { POST as create } from "@/app/api/listings/route";
import { GET as mine } from "@/app/api/listings/mine/route";
import { GET as get, PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { DEFAULT_LEGAL } from "@/config/legal";
import type { CreateListingResponse, FieldIssue, OwnerListingsResponse } from "@/lib/contracts/listings";
import { listContentOps, listingContentRef } from "@/lib/db/repositories/content-ops";
import { getListing } from "@/lib/db/repositories/listings";
import { getModerationDecision } from "@/lib/db/repositories/moderation-decisions";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { resetServerEnv } from "@/lib/env";
import { SLUG_ID_PATTERN } from "@/lib/listings/ids";
import { sendMail } from "@/lib/mail";
import { consumeLimit, resetRateLimiters } from "@/lib/rate-limit/limiter";
import type * as Turnstile from "@/lib/security/turnstile";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { capturedMails, lastMail } from "../auth/helpers";
import { DAY_MS, api, attachPhoto, member, readyPatch, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "./helpers";

const sendMailMock = vi.mocked(sendMail);
const ACCEPT = { acceptRules: true };
const LIMITED = { ok: false, reason: "limited", retryAfterSeconds: 60 } as const;

beforeAll(() => resetServerEnv());
beforeEach(() => {
  resetRateLimiters();
  sendMailMock.mockClear();
});

async function draft(owner: Member): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  expect(created.status).toBe(201);
  return created.body.id;
}

/** A complete draft with two ready photos (one through the PATCH, one attached by the pipeline). */
async function readyDraft(owner: Member, overrides: Parameters<typeof readyPatch>[0] = {}): Promise<string> {
  const id = await draft(owner);
  const saved = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch(overrides) });
  expect(saved.status).toBe(200);
  const first = await seedReadyUpload(owner, id);
  const second = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [first] } })).status).toBe(200);
  await attachPhoto(id, second);
  return id;
}

const codesOf = (issues: FieldIssue[]) => issues.map((issue) => `${issue.path}:${issue.code}`);

describe("POST /api/listings/{id}/publish", () => {
  it("publishes a complete draft: slugId, url, dates, outbox, contentOps, mail", async () => {
    const owner = await member();
    const id = await readyDraft(owner);
    const before = Date.now();
    const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "published", slugId: expect.stringMatching(SLUG_ID_PATTERN), url: `/fr/annonce/${result.body.slugId}`, flags: [], blockers: [] });
    expect(result.body.slugId).toBe(`velo-de-ville-peugeot-en-bon-etat-casablanca-${id}`);

    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "published", slugId: result.body.slugId, adsEligible: true, moderation: expect.objectContaining({ state: "auto_ok", flags: [] }) });
    expect(stored.publishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.expiresAt!.getTime() - stored.publishedAt!.getTime()).toBe(DEFAULT_LEGAL.listingTtlDays * DAY_MS);
    expect(stored.purgeAt!.getTime()).toBeGreaterThan(stored.expiresAt!.getTime());
    expect(stored.photos).toHaveLength(2);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: stored.version });
    expect(await listContentOps(listingContentRef(id))).toEqual(expect.arrayContaining([expect.objectContaining({ op: "listing.publish", ip: owner.jar.ip, uid: owner.uid })]));

    const mail = lastMail(sendMail, "listingPublished", owner.email);
    expect(mail?.data).toMatchObject({ title: "Vélo de ville Peugeot en bon état", url: `http://localhost:3000/fr/annonce/${result.body.slugId}`, expiresAt: stored.expiresAt!.toISOString() });
    expect(mail?.idempotencyKey).toBe(`listingPublished-${id}-${stored.version}`);

    const owned = await api<ListingBody>(get, "GET", `/api/listings/${id}`, { member: owner });
    expect(owned.body.listing).toMatchObject({ status: "published", slugId: result.body.slugId, publishedAt: stored.publishedAt!.toISOString(), expiresAt: stored.expiresAt!.toISOString() });
    const active = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=active", { member: owner });
    expect(active.body.listings.map((listing) => [listing.id, listing.canRenew, listing.photoCount])).toEqual([[id, false, 2]]);

    // Already published: 409. Someone else's draft: 404.
    const again = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
    const stranger = await member();
    expect((await api<ErrorBody>(publish, "POST", `/api/listings/${await draft(owner)}/publish`, { member: stranger, body: ACCEPT })).status).toBe(404);
  });

  it("answers 422 invalid_listing with the field issues of an incomplete draft", async () => {
    const owner = await member();
    const id = await draft(owner);
    const result = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("invalid_listing");
    expect(codesOf(result.body.error.details)).toEqual(expect.arrayContaining(["title:title_min", "description:description_min", "categoryId:category_required", "subcategoryId:subcategory_required", "location:city_required", "photos:photos_required"]));
    expect((await getListing(id))?.status).toBe("draft");
    // The body is a contract too.
    expect((await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: {} })).status).toBe(400);
    expect((await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: false } })).status).toBe(400);
  });

  it("blocks a shown phone without a verified number, a missing criterion and a number in the text", async () => {
    const owner = await member();
    const phone = await readyDraft(owner, { contact: { showPhone: true, whatsapp: true } });
    const refused = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${phone}/publish`, { member: owner, body: ACCEPT });
    expect(refused.status).toBe(422);
    expect(codesOf(refused.body.error.details)).toEqual(["contact.showPhone:phone_required", "contact.whatsapp:phone_required"]);

    const criteria = await readyDraft(owner, { attributes: { brand: "Peugeot" } });
    const missing = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${criteria}/publish`, { member: owner, body: ACCEPT });
    expect(codesOf(missing.body.error.details)).toEqual(["attributes.bike-type:criterion_required"]);

    // Readiness passes; the pre-moderation (step 3) refuses the number: use the reveal button.
    const inText = await readyDraft(owner, { description: "Vélo de ville 28 pouces, 6 vitesses, révisé récemment. Appelez-moi au 06 12 34 56 78 pour le voir." });
    const blocked = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${inText}/publish`, { member: owner, body: ACCEPT });
    expect(blocked.status).toBe(422);
    expect(codesOf(blocked.body.error.details)).toEqual(["description:phone_in_text"]);
    expect(capturedMails(sendMail)).toEqual([]);
    expect((await getListing(inText))?.status).toBe("draft");
  });

  it("screens the free-text district (422 on a phone number in it)", async () => {
    const owner = await member();
    const id = await readyDraft(owner, { location: { regionCode: "06", citySlug: "casablanca", district: "Maarif, appelez 0612345678" } });
    const blocked = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(blocked.status).toBe(422);
    expect(codesOf(blocked.body.error.details)).toEqual(["location.district:phone_in_text"]);
    expect((await getListing(id))?.status).toBe("draft");
  });

  it("holds a flagged listing in pending_review with the statement of reasons", async () => {
    const owner = await member();
    const id = await readyDraft(owner, { title: "Réplique de vélo de course vintage" });
    const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "pending_review", slugId: expect.stringMatching(SLUG_ID_PATTERN), flags: ["prohibited_soft"], blockers: [] });
    expect(result.body).not.toHaveProperty("url");

    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "pending_review", adsEligible: false, moderation: expect.objectContaining({ state: "needs_review", flags: ["prohibited_soft"] }) });
    expect(stored.publishedAt).toBeUndefined();
    expect(await getSearchOutbox(id)).toBeNull();
    const decision = await getModerationDecision(stored.moderation.lastDecisionId!);
    expect(decision).toMatchObject({ target: { type: "listing", id }, affectedUid: owner.uid, action: "restrict_visibility", decidedBy: "system", templateId: "listingPendingReview", automation: { detection: true, decision: true } });
    expect(decision?.facts).toContain("prohibited_soft");

    const mail = lastMail(sendMail, "listingPendingReview", owner.email);
    expect(mail?.data).toMatchObject({ listingId: id, statement: { measure: "hold", facts: ["prohibited_soft"], automated: true, redress: DEFAULT_LEGAL.dsaContactEmail } });
    expect(mail?.data.statement.ground).toMatch(/CGU/);
    const pending = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=pending", { member: owner });
    expect(pending.body.listings.map((listing) => listing.id)).toEqual([id]);
  });

  it("publishes an adults-only listing (decorative koumiyas) only with the attestation, always held for a moderator", async () => {
    const owner = await member();
    const koumiya = {
      subcategoryId: "koumiyas-decoratives",
      title: "Koumiya décorative en cuivre ciselé",
      description: "Koumiya de décoration faite à la main par un artisan de Fès, fourreau en cuivre ciselé, à accrocher au mur.",
      attributes: { material: "cuivre", handmade: true },
      price: 1200,
    };
    const shown = await readyDraft(owner, { ...koumiya, contact: { showPhone: true, whatsapp: false } });
    const messagingOnly = await api<ErrorBody & { error: { details: FieldIssue[] } }>(publish, "POST", `/api/listings/${shown}/publish`, { member: owner, body: { ...ACCEPT, adultsOnlyAttestation: true } });
    expect(messagingOnly.status).toBe(422);
    expect(codesOf(messagingOnly.body.error.details)).toEqual(["contact.showPhone:messaging_only"]);

    const id = await readyDraft(owner, koumiya);
    const missing = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("adults_only_attestation");
    expect((await getListing(id))?.status).toBe("draft");

    const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, adultsOnlyAttestation: true } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "pending_review", flags: ["restricted_category"] });
    expect((await getListing(id))?.moderation).toMatchObject({ state: "needs_review", flags: ["restricted_category"], score: 0 });
  });

  it("publishes a real-estate listing only with the advertiser's attestation of its declared data", async () => {
    const owner = await member();
    const id = await readyDraft(owner, {
      subcategoryId: "vente",
      title: "Appartement de 85 m² au Maârif",
      description: "Appartement lumineux de 85 m² au troisième étage avec ascenseur, deux chambres, cuisine équipée. Titre foncier.",
      attributes: { "property-type": "appartement", surface: 85, "property-title": "titre-foncier" },
      price: 950000,
    });
    const missing = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("real_estate_attestation");
    expect((await getListing(id))?.status).toBe("draft");

    const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, realEstateAttestation: true } });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("published");
  });

  it("limits an individual to 5 publications a day (listing_daily_limit, Retry-After)", { timeout: 90_000 }, async () => {
    const owner = await member();
    for (let i = 0; i < 5; i += 1) {
      const id = await readyDraft(owner, { title: `Vélo de ville numéro ${i + 1} en bon état`, description: `Vélo de ville ${i + 1}, 28 pouces, 6 vitesses, révisé récemment, deux pneus neufs. Remise en main propre à Casablanca.` });
      const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
      expect(result.status, `publication ${i + 1}`).toBe(200);
      expect(result.body.status).toBe("published");
    }
    const sixth = await readyDraft(owner, { title: "Vélo de ville numéro six en bon état", description: "Sixième vélo de ville, 28 pouces, 6 vitesses, révisé récemment, deux pneus neufs. Remise en main propre à Casablanca." });
    const limited = await api<ErrorBody>(publish, "POST", `/api/listings/${sixth}/publish`, { member: owner, body: ACCEPT });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("listing_daily_limit");
    expect(Number(limited.header("retry-after"))).toBeGreaterThan(0);
    expect((await getListing(sixth))?.status).toBe("draft");
    // Another account on the same network is not affected.
    const neighbour = await member();
    const theirs = await readyDraft(neighbour);
    expect((await api<PublishBody>(publish, "POST", `/api/listings/${theirs}/publish`, { member: neighbour, body: ACCEPT, ip: owner.jar.ip })).status).toBe(200);
  });

  it("escalates to Turnstile past the IP allowance; a solved challenge sets the pass cookie", async () => {
    const owner = await member();
    const id = await readyDraft(owner);
    vi.mocked(consumeLimit).mockResolvedValueOnce(LIMITED);
    const challenged = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: ACCEPT });
    expect(challenged.status).toBe(403);
    expect(challenged.body.error.code).toBe("turnstile_required");
    expect((await getListing(id))?.status).toBe("draft");

    vi.mocked(consumeLimit).mockResolvedValueOnce(LIMITED);
    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, codes: ["invalid-input-response"] });
    const failed = await api<ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, turnstileToken: "bad" } });
    expect(failed.status).toBe(403);
    expect(failed.body.error.code).toBe("turnstile_failed");

    vi.mocked(consumeLimit).mockResolvedValueOnce(LIMITED);
    const solved = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { ...ACCEPT, turnstileToken: "solved" } });
    expect(solved.status).toBe(200);
    expect(solved.body.status).toBe("published");
    expect(vi.mocked(verifyTurnstile)).toHaveBeenLastCalledWith("solved", expect.objectContaining({ action: "listing", hostname: "localhost" }));
    expect(owner.jar.get("__Host-tsv")).toBeDefined();
    expect(owner.jar.get("__Host-did")).toBeDefined();

    // The pass lifts the challenge for this device on the next publication.
    const next = await readyDraft(owner, { title: "Deuxième vélo de ville en bon état" });
    vi.mocked(consumeLimit).mockResolvedValueOnce(LIMITED);
    const passed = await api<PublishBody>(publish, "POST", `/api/listings/${next}/publish`, { member: owner, body: ACCEPT });
    expect(passed.status).toBe(200);
    expect(vi.mocked(verifyTurnstile)).toHaveBeenCalledTimes(2);
  });
});
