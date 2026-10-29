import { randomInt } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PUT /api/pro/me/social against the emulators: the owner of a verified shop saves its social
// links (handles kept, links rebuilt), read back by GET /api/pro/me and the storefront; a link off
// the network's site or a phone number is refused; a moderator hides and restores them, the owner
// is mailed, and an edit while hidden keeps them hidden.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { GET as getMe } from "@/app/api/pro/me/route";
import { PUT as putSocial } from "@/app/api/pro/me/social/route";
import { GET as getShopSocial, POST as postShopSocial } from "@/app/api/admin/pros/[proId]/social/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { ProMeResponse, ProSocialResponse, ProSocialView } from "@/lib/contracts/pro";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { getPublicStorefront } from "@/lib/listings/public";
import { sendMail } from "@/lib/mail";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, member, type ErrorBody, type Member } from "../listings/helpers";
import { admin, code, staffAccount } from "./helpers";

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");

beforeEach(() => resetRateLimiters());

/** A verified shop on the launch offer, linked to its owner's account and signed in as its owner. */
async function shop(owner: Member, extra: Partial<ProProfileDoc> = {}): Promise<string> {
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Dar Argan",
    slug: `dar-argan-${proId}`,
    description: "Huile d'argan de coopérative.",
    whatsapp: false,
    regionCode: "09",
    citySlug: "agadir",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "essentiel",
    planSource: "launch_offer",
    quotas: DEFAULT_PRICING.pro.essentiel,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await db().collection(COLLECTIONS.users).doc(owner.uid).update({ proId });
  await setClaims(owner.uid, { role: "pro", proId, proRole: "owner", v: 2 });
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return proId;
}

const put = (owner: Member, links: { network: string; value: string }[]) => api<ProSocialResponse & ErrorBody>(putSocial, "PUT", "/api/pro/me/social", { member: owner, body: { links } });

describe("PUT /api/pro/me/social", () => {
  it("stores handles only and shows the rebuilt links on the storefront", async () => {
    const owner = await member();
    const proId = await shop(owner);
    const saved = await put(owner, [
      { network: "whatsapp", value: "https://wa.me/message/ABCDEFGHIJ2K1" },
      { network: "instagram", value: "https://www.instagram.com/Dar.Argan/?hl=fr" },
      { network: "facebook", value: "" },
    ]);
    expect(saved.status).toBe(200);
    expect(saved.body.social).toEqual({
      links: [
        { network: "instagram", handle: "dar.argan", href: "https://www.instagram.com/dar.argan/" },
        { network: "whatsapp", handle: "ABCDEFGHIJ2K1", href: "https://wa.me/message/ABCDEFGHIJ2K1" },
      ],
      hidden: null,
    });
    expect((await getProProfile(proId))?.social?.links).toEqual([
      { network: "instagram", handle: "dar.argan" },
      { network: "whatsapp", handle: "ABCDEFGHIJ2K1" },
    ]);
    const me = await api<ProMeResponse>(getMe, "GET", "/api/pro/me", { member: owner });
    expect(me.body.shop?.social.links).toHaveLength(2);
    expect((await getPublicStorefront(proId))?.social.map((link) => link.href)).toEqual(["https://www.instagram.com/dar.argan/", "https://wa.me/message/ABCDEFGHIJ2K1"]);

    const cleared = await put(owner, []);
    expect(cleared.body.social).toEqual({ links: [], hidden: null });
    expect((await getProProfile(proId))?.social).toBeUndefined();
  });

  it("refuses another site, a phone number, a duplicate network, and a shop that cannot publish", async () => {
    const owner = await member();
    await shop(owner);
    const shortener = await put(owner, [{ network: "instagram", value: "https://bit.ly/dar-argan" }]);
    expect(shortener.status).toBe(422);
    expect(code(shortener.body)).toBe("social_link_invalid");
    expect((shortener.body as unknown as { error: { details: unknown } }).error.details).toEqual({ network: "instagram", problem: "host" });
    const phone = await put(owner, [{ network: "whatsapp", value: "https://wa.me/212612345678" }]);
    expect((phone.body as unknown as { error: { details: unknown } }).error.details).toEqual({ network: "whatsapp", problem: "phone" });
    expect((await put(owner, [{ network: "x", value: "a" }, { network: "x", value: "b" }])).status).toBe(400);
    expect((await put(owner, [{ network: "myspace", value: "a" }])).status).toBe(400);

    const suspended = await member();
    await shop(suspended, { lifecycle: "suspended", suspendedFrom: "verified" });
    expect(code((await put(suspended, [{ network: "x", value: "@dar_argan" }])).body)).toBe("pro_not_verified");
    const individual = await member();
    expect(code((await put(individual, [{ network: "x", value: "@dar_argan" }])).body)).toBe("pro_not_verified");
  });

  it("lets a moderator hide and restore the links; an edit while hidden keeps them hidden", async () => {
    const moderator = await staffAccount("moderator");
    const owner = await member();
    const proId = await shop(owner);
    await put(owner, [{ network: "tiktok", value: "@dar.argan" }]);
    const hidden = await admin<ProSocialView>(postShopSocial, "POST", `/api/admin/pros/${proId}/social`, moderator, { action: "hide", reason: "Signalé : compte TikTok d'un autre vendeur." });
    expect(hidden.body.hidden).toMatchObject({ reason: "Signalé : compte TikTok d'un autre vendeur." });
    expect((await getPublicStorefront(proId))?.social).toEqual([]);
    expect(vi.mocked(sendMail).mock.calls.at(-1)?.[0]).toMatchObject({ template: "socialLinksNotice", data: { kind: "hidden" } });

    const edited = await put(owner, [{ network: "tiktok", value: "@dar.argan.officiel" }]);
    expect(edited.body.social.hidden).not.toBeNull();
    expect((await getPublicStorefront(proId))?.social).toEqual([]);

    await admin(postShopSocial, "POST", `/api/admin/pros/${proId}/social`, moderator, { action: "restore", reason: "Compte vérifié avec la boutique." });
    expect((await getPublicStorefront(proId))?.social.map((link) => link.handle)).toEqual(["dar.argan.officiel"]);
    expect((await admin<ProSocialView>(getShopSocial, "GET", `/api/admin/pros/${proId}/social`, moderator)).body.hidden).toBeNull();
    expect((await admin(postShopSocial, "POST", `/api/admin/pros/${proId}/social`, moderator, { action: "hide", reason: "x" })).status).toBe(400);
  });
});
