import { randomInt } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PUT /api/pro/me/agency (Agence pack design §3) against the emulators: the owner of a verified
// shop sets its sector and fee schedule, read back by GET /api/pro/me; a text with contact details
// is refused, an account without a shop or a suspended shop cannot set it.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { GET as getMe } from "@/app/api/pro/me/route";
import { PUT as putAgency } from "@/app/api/pro/me/agency/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { ProAgencyResponse, ProMeResponse } from "@/lib/contracts/pro";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, member, type ErrorBody, type Member } from "../listings/helpers";
import { COMMITMENTS_VERSION } from "@/lib/pro/commitments";

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const code = (body: unknown) => (body as ErrorBody).error.code;

beforeEach(() => resetRateLimiters());

/** A verified shop on the launch offer, linked to its owner's account and signed in as its owner. */
async function shop(owner: Member, extra: Partial<ProProfileDoc> = {}): Promise<string> {
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Atlas Immobilier",
    slug: `atlas-immobilier-${proId}`,
    description: "Appartements et villas à Casablanca.",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
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

const put = (owner: Member, body: unknown) => api<ProAgencyResponse & ErrorBody>(putAgency, "PUT", "/api/pro/me/agency", { member: owner, body });

describe("PUT /api/pro/me/agency", () => {
  it("makes the shop an agency with its fee schedule, then a general shop again", async () => {
    const owner = await member();
    const proId = await shop(owner);
    const fees = "Vente : 2,5 % du prix à la charge de l'acquéreur.\nLocation : un mois de loyer.";
    const set = await put(owner, { sector: "real_estate", feeSchedule: `  ${fees}  `, acceptCommitments: true });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ sector: "real_estate", feeSchedule: fees });
    expect((await getProProfile(proId))?.agency).toEqual({ feeSchedule: fees });
    expect((await getProProfile(proId))?.sectorCommitment).toMatchObject({ sector: "real_estate", version: COMMITMENTS_VERSION });
    // The fee schedule of an agency changes without a new acknowledgment.
    expect((await put(owner, { sector: "real_estate", feeSchedule: fees })).status).toBe(200);
    const read = await api<ProMeResponse>(getMe, "GET", "/api/pro/me", { member: owner });
    expect(read.body.shop).toMatchObject({ sector: "real_estate", feeSchedule: fees });

    const back = await put(owner, { sector: "general", feeSchedule: fees });
    expect(back.body).toEqual({ sector: "general", feeSchedule: "" });
    const profile = await getProProfile(proId);
    expect(profile?.sector).toBe("general");
    expect(profile?.agency).toBeUndefined();
  });

  it("refuses to become an agency without the commitments", async () => {
    const owner = await member();
    const proId = await shop(owner);
    for (const sector of ["real_estate", "car_rental"]) {
      const refused = await put(owner, { sector, feeSchedule: "" });
      expect(refused.status).toBe(400);
      expect(code(refused.body)).toBe("commitments_required");
    }
    const profile = await getProProfile(proId);
    expect(profile?.sector ?? "general").toBe("general");
    expect(profile?.sectorCommitment).toBeUndefined();
    expect((await put(owner, { sector: "car_rental", feeSchedule: "", acceptCommitments: true })).status).toBe(200);
    expect((await getProProfile(proId))?.sectorCommitment).toMatchObject({ sector: "car_rental", version: COMMITMENTS_VERSION });
  });

  it("refuses a fee schedule with contact details, and a shop that cannot publish", async () => {
    const owner = await member();
    await shop(owner);
    const refused = await put(owner, { sector: "real_estate", feeSchedule: "Appelez le 06 12 34 56 78", acceptCommitments: true });
    expect(refused.status).toBe(422);
    expect(code(refused.body)).toBe("invalid_text");
    expect((refused.body as unknown as { error: { details: unknown } }).error.details).toEqual({ field: "feeSchedule", issue: "phone_in_text" });

    const suspended = await member();
    await shop(suspended, { lifecycle: "suspended", suspendedFrom: "verified" });
    expect(code((await put(suspended, { sector: "real_estate", feeSchedule: "" })).body)).toBe("pro_not_verified");

    const individual = await member();
    const none = await put(individual, { sector: "real_estate", feeSchedule: "" });
    expect(none.status).toBe(409);
    expect(code(none.body)).toBe("pro_not_verified");
    expect((await put(owner, { sector: "agency", feeSchedule: "" })).status).toBe(400);
  });
});
