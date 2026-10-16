import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Phone reveal (architecture §6 "/api/listings/[id]/phone"): who may ask (signed in, verified
// e-mail, account older than 24 hours), on which listings (published, phone shown), what is written
// (revealLogs with hashed prefixes, listingStats.phoneReveals, once per viewer) and the IP escalation.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as reveal } from "@/app/api/listings/[id]/phone/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import type { CreateListingResponse, ListingPatch, PhoneRevealResponse } from "@/lib/contracts/listings";
import { getListingStats } from "@/lib/db/repositories/listing-stats";
import { listRevealLogs } from "@/lib/db/repositories/reveal-logs";
import { resetServerEnv } from "@/lib/env";
import { displayPhone } from "@/lib/phone/normalize";
import { consumeLimit, resetRateLimiters } from "@/lib/rate-limit/limiter";
import type * as Turnstile from "@/lib/security/turnstile";
import { DAY_MS, api, freshPhone, member, readyPatch, seedReadyUpload, type ErrorBody, type ListingBody, type Member } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

async function listingOf(owner: Member, contact: ListingPatch["contact"] = { showPhone: true, whatsapp: true }, publishIt = true): Promise<string> {
  const id = (await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} })).body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ contact }) })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  if (publishIt) expect((await api(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } })).status).toBe(200);
  return id;
}

const ask = (viewer: Member | undefined, id: string, body?: unknown) => api<PhoneRevealResponse & ErrorBody>(reveal, "POST", `/api/listings/${id}/phone`, { member: viewer, body });

describe("POST /api/listings/{id}/phone", () => {
  it("reveals the seller's verified number once per viewer, logged and counted", async () => {
    const phone = freshPhone();
    const owner = await member({ phone });
    const viewer = await member();
    const id = await listingOf(owner);

    const result = await ask(viewer, id);
    expect(result.status).toBe(200);
    expect(result.header("cache-control")).toBe("no-store");
    expect(result.body).toEqual({ phone: { e164: phone, display: displayPhone(phone), whatsappUrl: `https://wa.me/${phone.slice(1)}` } });
    expect(result.body.phone.display).toMatch(/^06 \d\d \d\d \d\d \d\d$/);

    const logs = await listRevealLogs(id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ viewerUid: viewer.uid, listingId: id });
    // Hashed network prefix and device, never the IP or the uid of the device.
    expect(logs[0]!.ipPrefixHash).not.toContain(viewer.jar.ip);
    expect(logs[0]!.ipPrefixHash).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(logs[0]!.purgeAt.getTime() - logs[0]!.at.getTime()).toBe(90 * DAY_MS);
    expect(await getListingStats(id)).toMatchObject({ phoneReveals: 1, views: 0 });

    // The same viewer again: same answer, nothing new written or counted.
    const again = await ask(viewer, id);
    expect(again.status).toBe(200);
    expect(await listRevealLogs(id)).toHaveLength(1);
    expect((await getListingStats(id))?.phoneReveals).toBe(1);
    // Another viewer counts.
    expect((await ask(await member(), id)).status).toBe(200);
    expect((await getListingStats(id))?.phoneReveals).toBe(2);
  });

  it("omits WhatsApp when the seller only shows the number", async () => {
    const owner = await member({ phone: freshPhone() });
    const id = await listingOf(owner, { showPhone: true, whatsapp: false });
    const result = await ask(await member(), id);
    expect(result.status).toBe(200);
    expect(result.body.phone).not.toHaveProperty("whatsappUrl");
  });

  it("refuses an account younger than 24 hours and an unverified e-mail (reveal_not_allowed)", async () => {
    const owner = await member({ phone: freshPhone() });
    const id = await listingOf(owner);
    const young = await member({ createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000) });
    const refused = await ask(young, id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("reveal_not_allowed");
    const unverified = await member({ emailVerified: false });
    const alsoRefused = await ask(unverified, id);
    expect(alsoRefused.status).toBe(403);
    expect(alsoRefused.body.error.code).toBe("reveal_not_allowed");
    expect(await listRevealLogs(id)).toEqual([]);
    expect(await getListingStats(id)).toBeNull();
    // Anonymous: 401; the owner's own listing works like anyone's.
    expect((await ask(undefined, id)).status).toBe(401);
    expect((await ask(owner, id)).status).toBe(200);
  });

  it("answers 404 when no number is shown or the listing is a draft, 409 when it is not live", async () => {
    const owner = await member({ phone: freshPhone() });
    const viewer = await member();
    const hidden = await listingOf(owner, { showPhone: false, whatsapp: false });
    expect((await ask(viewer, hidden)).status).toBe(404);
    const draft = await listingOf(owner, { showPhone: true, whatsapp: true }, false);
    expect((await ask(viewer, draft)).status).toBe(404);
    expect((await ask(viewer, "abcd2345")).status).toBe(404);
    expect((await ask(viewer, "not-an-id")).status).toBe(404);

    const live = await listingOf(owner);
    expect((await api(pause, "POST", `/api/listings/${live}/pause`, { member: owner })).status).toBe(200);
    const paused = await ask(viewer, live);
    expect(paused.status).toBe(409);
    expect(paused.body.error.code).toBe("listing_unavailable");
    expect(await listRevealLogs(live)).toEqual([]);
  });

  it("escalates to Turnstile past the IP allowance and rejects a malformed body", async () => {
    const owner = await member({ phone: freshPhone() });
    const viewer = await member();
    const id = await listingOf(owner);
    vi.mocked(consumeLimit).mockResolvedValueOnce({ ok: false, reason: "limited", retryAfterSeconds: 60 });
    const challenged = await ask(viewer, id);
    expect(challenged.status).toBe(403);
    expect(challenged.body.error.code).toBe("turnstile_required");
    expect(await listRevealLogs(id)).toEqual([]);

    vi.mocked(consumeLimit).mockResolvedValueOnce({ ok: false, reason: "limited", retryAfterSeconds: 60 });
    const solved = await ask(viewer, id, { turnstileToken: "solved" });
    expect(solved.status).toBe(200);
    expect(viewer.jar.get("__Host-tsv")).toBeDefined();
    expect(await listRevealLogs(id)).toHaveLength(1);

    const bad = await ask(await member(), id, { token: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_body");
  });
});
