import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Check of a car rental agency's licence decision (decision 5) against the Firebase emulators and
// an in-memory object store: the document is signed as a KYBC piece by a publishing agency with a
// reference, sent for its check (no queue here: straight to a moderator), read by a stubbed Claude
// in the worker's job (consistent: verified by "ai"; any doubt: review, with the reasons), decided
// by a moderator, shown on the storefront, kept with the profile, and dropped by a new reference.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as decide } from "@/app/api/admin/pros/[proId]/rental-check/route";
import { GET as getReview } from "@/app/api/admin/pros/[proId]/route";
import { DELETE as removePiece } from "@/app/api/pro/kybc/uploads/[id]/route";
import { POST as sign } from "@/app/api/pro/kybc/uploads/route";
import { GET as getMe } from "@/app/api/pro/me/route";
import { POST as submit } from "@/app/api/pro/me/rental/check/route";
import { PUT as putRental } from "@/app/api/pro/me/rental/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import Anthropic from "@anthropic-ai/sdk";
import type { KybcSignResponse, ProMeResponse, ProReview, RentalCheckDecisionResponse, RentalCheckResponse } from "@/lib/contracts/pro";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { getPublicStorefront } from "@/lib/listings/public";
import { runRentalCheck, setRentalCheckClientForTests, type RentalCheckClient } from "@/lib/pro/rental-check";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { api, member, type ErrorBody, type Handler, type Member } from "../listings/helpers";
import { admin, code, kybPiece, staffAccount } from "./helpers";

const store = new MemoryObjectStore();
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => {
  resetObjectStore();
  setRentalCheckClientForTests(undefined);
});
beforeEach(() => {
  resetRateLimiters();
  store.clear();
  setRentalCheckClientForTests(null);
});

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const ICE = "001234567000089";
const SETTINGS = { agrementRef: "AGR 123/2025", branches: [], hours: "", payments: [], airports: [] };

interface Agency extends Member {
  proId: string;
}

/** A verified car rental agency on the launch offer, signed in as its owner; `settings: false` before it saved its reference. */
async function agency({ settings = true }: { settings?: boolean } = {}): Promise<Agency> {
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
      legal: { form: "societe", ice: ICE, rc: "12345", if: "1234567" },
      kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
      lifecycle: "verified",
      plan: "essentiel",
      planSource: "launch_offer",
      quotas: DEFAULT_PRICING.pro.essentiel,
      sector: "car_rental",
      ...(settings ? { rental: SETTINGS } : {}),
      createdAt: now,
      updatedAt: now,
    }),
  );
  await db().collection(COLLECTIONS.users).doc(owner.uid).update({ type: "pro", proId });
  await setClaims(owner.uid, { role: "pro", proId, proRole: "owner" });
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return { ...owner, proId };
}

const send = (owner: Member, uploadId: string) => api<RentalCheckResponse & ErrorBody>(submit, "POST", "/api/pro/me/rental/check", { member: owner, body: { uploadId } });
const me = async (owner: Member) => (await api<ProMeResponse>(getMe, "GET", "/api/pro/me", { member: owner })).body.shop;
const withId =
  (handler: Handler, id: string): Handler =>
  (request, context) =>
    handler(request, { params: context.params.then(() => ({ id })) });

/** A licence document in the private bucket, as the KYBC upload path leaves it. */
async function documentOf(owner: Member): Promise<string> {
  const id = await kybPiece(owner, { declaredType: "application/pdf" });
  await store.put("private", `kyb/${owner.uid}/${id}`, PDF, { contentType: "application/pdf" });
  return id;
}

/** Makes the agency's check pending again for `uploadId`, as a submission with a queue leaves it. */
async function pending(owner: Agency, uploadId: string, submittedAt = new Date()): Promise<number> {
  await proProfileRef(owner.proId).update({ rentalCheck: datesToTimestamps({ status: "pending", uploadId, agrementRef: SETTINGS.agrementRef, submittedAt, issues: [] }) });
  return submittedAt.getTime();
}

const READING = {
  isAgrementDecision: true,
  legible: true,
  companyName: "STE OCEAN RENT SARL",
  ice: ICE,
  reference: "N° 123/2025",
  decisionDate: "2025-03-14",
  tamperingSigns: [] as string[],
  confidence: 0.94,
  note: "Décision du ministère du Transport, lisible.",
};

function claude(reading: Partial<typeof READING> | Error = {}): RentalCheckClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    messages: {
      parse: (async (request: unknown) => {
        calls.push(request);
        if (reading instanceof Error) throw reading;
        return { stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 400 }, parsed_output: { ...READING, ...reading } };
      }) as unknown as RentalCheckClient["messages"]["parse"],
    },
  };
}

describe("licence document upload", () => {
  it("signs for a publishing agency with a saved reference only", async () => {
    const body = { declaredType: "application/pdf", declaredSize: PDF.byteLength, use: "agrement" };
    const unsaved = await agency({ settings: false });
    const refused = await api<ErrorBody>(sign, "POST", "/api/pro/kybc/uploads", { member: unsaved, body });
    expect(refused.status).toBe(409);
    expect(code(refused.body)).toBe("rental_agrement_missing");
    const owner = await agency();
    expect((await api<KybcSignResponse>(sign, "POST", "/api/pro/kybc/uploads", { member: owner, body })).status).toBe(201);
    const individual = await member();
    expect((await api<ErrorBody>(sign, "POST", "/api/pro/kybc/uploads", { member: individual, body })).status).toBe(409);
  });
});

describe("licence check", () => {
  it("goes to a moderator without a queue, who verifies it: the storefront shows it", async () => {
    const owner = await agency();
    const uploadId = await documentOf(owner);
    const sent = await send(owner, uploadId);
    expect(sent.status).toBe(200);
    expect(sent.body.rentalCheck).toMatchObject({ status: "review", checkedAt: null, method: null });
    expect((await getProProfile(owner.proId))?.rentalCheck).toMatchObject({ status: "review", issues: ["ai_unavailable"], uploadId });
    expect((await me(owner))?.rentalCheck?.status).toBe("review");
    // Sending the same document again answers it, without a new check.
    expect((await send(owner, uploadId)).body.rentalCheck.submittedAt).toBe(sent.body.rentalCheck.submittedAt);
    // The document is kept with its check.
    expect((await api<ErrorBody>(withId(removePiece, uploadId), "DELETE", `/api/pro/kybc/uploads/${uploadId}`, { member: owner })).status).toBe(409);

    const moderator = await staffAccount("moderator");
    const review = await admin<{ review: ProReview }>(getReview, "GET", `/api/admin/pros/${owner.proId}`, moderator);
    expect(review.body.review.rentalCheck).toMatchObject({ status: "review", agrementRef: "AGR 123/2025", issues: ["ai_unavailable"], extracted: null, piece: { id: uploadId, status: "ready" } });
    const path = `/api/admin/pros/${owner.proId}/rental-check`;
    const stale = await admin<ErrorBody>(decide, "POST", path, moderator, { action: "verify", submittedAt: new Date(0).toISOString() });
    expect(stale.status).toBe(409);
    const verified = await admin<RentalCheckDecisionResponse>(decide, "POST", path, moderator, { action: "verify", submittedAt: sent.body.rentalCheck.submittedAt });
    expect(verified.body).toEqual({ proId: owner.proId, status: "verified" });
    expect((await getProProfile(owner.proId))?.rentalCheck).toMatchObject({ status: "verified", method: "staff", by: moderator.uid });
    expect((await getPublicStorefront(owner.proId))?.rentalCheckedAt).toEqual(expect.any(String));
    expect((await admin<ErrorBody>(decide, "POST", path, moderator, { action: "verify", submittedAt: sent.body.rentalCheck.submittedAt })).status).toBe(409);
  });

  it("is refused with a reason the agency reads, then another document may be sent", async () => {
    const owner = await agency();
    const sent = await send(owner, await documentOf(owner));
    const moderator = await staffAccount("moderator");
    const path = `/api/admin/pros/${owner.proId}/rental-check`;
    expect((await admin<ErrorBody>(decide, "POST", path, moderator, { action: "reject", reason: "court", submittedAt: sent.body.rentalCheck.submittedAt })).status).toBe(400);
    const reason = "Le numéro de la décision ne correspond pas à celui déclaré.";
    expect((await admin<RentalCheckDecisionResponse>(decide, "POST", path, moderator, { action: "reject", reason, submittedAt: sent.body.rentalCheck.submittedAt })).body.status).toBe("rejected");
    expect((await me(owner))?.rentalCheck).toMatchObject({ status: "rejected", method: "staff", reason });
    expect((await getPublicStorefront(owner.proId))?.rentalCheckedAt).toBeNull();
    expect((await send(owner, await documentOf(owner))).body.rentalCheck.status).toBe("review");
  });

  it("refuses someone else's piece, a piece not ready, and an agency without a reference", async () => {
    const owner = await agency();
    const other = await agency();
    expect((await send(owner, await documentOf(other))).status).toBe(404);
    const unsaved = await agency({ settings: false });
    const missing = await send(unsaved, await documentOf(unsaved));
    expect(missing.status).toBe(409);
    expect(code(missing.body)).toBe("rental_agrement_missing");
    expect((await send(owner, "nopenopenope1")).status).toBe(404);
  });

  it("is dropped by a new reference in the settings", async () => {
    const owner = await agency();
    await send(owner, await documentOf(owner));
    const put = (body: unknown) => api<ErrorBody>(putRental, "PUT", "/api/pro/me/rental", { member: owner, body });
    expect((await put({ ...SETTINGS, hours: "Tous les jours" })).status).toBe(200);
    expect((await getProProfile(owner.proId))?.rentalCheck).toBeDefined();
    expect((await put({ ...SETTINGS, agrementRef: "AGR 456/2026" })).status).toBe(200);
    expect((await getProProfile(owner.proId))?.rentalCheck).toBeUndefined();
    expect((await me(owner))?.rentalCheck).toBeNull();
  });
});

describe("the worker's reading", () => {
  it("verifies a consistent document by AI, without sending the declarations to Claude", async () => {
    const owner = await agency();
    const uploadId = await documentOf(owner);
    const submittedAt = await pending(owner, uploadId);
    const stub = claude();
    setRentalCheckClientForTests(stub);
    expect(await runRentalCheck({ proId: owner.proId, submittedAt })).toMatchObject({ status: "done", outcome: "verified" });
    expect((await getProProfile(owner.proId))?.rentalCheck).toMatchObject({ status: "verified", method: "ai", issues: [], extracted: { reference: "N° 123/2025", ice: ICE, signs: [] } });
    const request = JSON.stringify(stub.calls[0]);
    expect(request).toContain('"type":"document"');
    expect(request).not.toContain("123/2025");
    expect(request).not.toContain(ICE);
    // The same job again finds nothing pending.
    expect((await runRentalCheck({ proId: owner.proId, submittedAt })).status).toBe("skipped");
    expect((await getPublicStorefront(owner.proId))?.rentalCheckedAt).toEqual(expect.any(String));
  });

  it("leaves any doubt to a moderator, with the reasons", async () => {
    const owner = await agency();
    const uploadId = await documentOf(owner);
    const submittedAt = await pending(owner, uploadId);
    setRentalCheckClientForTests(claude({ reference: "456/2025", tamperingSigns: ["Numéro en surimpression"], confidence: 0.6 }));
    expect((await runRentalCheck({ proId: owner.proId, submittedAt })).outcome).toBe("review");
    expect((await getProProfile(owner.proId))?.rentalCheck).toMatchObject({
      status: "review",
      issues: ["reference", "tampering", "low_confidence"],
      extracted: { signs: ["Numéro en surimpression"] },
    });
    expect((await getPublicStorefront(owner.proId))?.rentalCheckedAt).toBeNull();
  });

  it("retries a transient failure, then leaves it to a moderator on the last attempt; no key reads nothing", async () => {
    const owner = await agency();
    const uploadId = await documentOf(owner);
    let submittedAt = await pending(owner, uploadId);
    setRentalCheckClientForTests(null);
    expect((await runRentalCheck({ proId: owner.proId, submittedAt })).outcome).toBe("review");
    expect((await getProProfile(owner.proId))?.rentalCheck?.issues).toEqual(["ai_unavailable"]);

    submittedAt = await pending(owner, uploadId, new Date(Date.now() + 1000));
    const failing = claude(new Anthropic.APIConnectionError({ message: "connection reset" }));
    setRentalCheckClientForTests(failing);
    await expect(runRentalCheck({ proId: owner.proId, submittedAt })).rejects.toBeDefined();
    expect((await getProProfile(owner.proId))?.rentalCheck?.status).toBe("pending");
    expect((await runRentalCheck({ proId: owner.proId, submittedAt }, { final: true })).outcome).toBe("review");
    expect((await getProProfile(owner.proId))?.rentalCheck?.issues).toEqual(["ai_unavailable"]);
  });
});
