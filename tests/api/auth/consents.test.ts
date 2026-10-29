import { beforeEach, describe, expect, it, vi } from "vitest";
import { cguEffectiveFor } from "@/config/legal-versions";
import { CGU_VERSION, TRANSFERS_CONSENT_VERSION } from "@/lib/contracts/auth";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import type * as Turnstile from "@/lib/security/turnstile";
import { POST as action } from "@/app/api/auth/action/route";
import { POST as consents } from "@/app/api/auth/consents/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { CONSENTS, Jar, PASSWORD, actionUrlOf, call, lastMail, oobCodeOf, uniqueEmail, type ErrorBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

// POST /api/auth/consents (design D12, audit C2-04): the re-consent panel renews the transfers
// consent; only consents.transfers changes and an audit entry without personal data is written.

const CONSENTS_PATH = "/api/auth/consents";

async function verifiedAccount() {
  const jar = new Jar();
  const email = uniqueEmail("rc");
  expect((await call(signup, "/api/auth/signup", { jar, body: { email, password: PASSWORD, displayName: "Consent Tester", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
  const verified = await call<{ session: { uid: string } }>(action, "/api/auth/action", { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(await actionUrlOf(lastMail(sendMail, "verifyEmail", email)!)) } });
  expect(verified.status).toBe(200);
  return { jar, email, uid: verified.body.session.uid };
}

const privateDoc = (uid: string) => db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);

/** An account created before the bump: the stored version is the previous text's. */
async function withOldConsent(uid: string, at = new Date("2026-10-14T10:00:00Z")): Promise<void> {
  await privateDoc(uid).update({ "consents.transfers": { version: "2026-10", at } });
}

async function auditEntries(uid: string) {
  const snapshot = await db().collection(COLLECTIONS.auditLogs).where("actorUid", "==", uid).get();
  return snapshot.docs.map((doc) => doc.data());
}

beforeEach(() => resetRateLimiters());

describe("POST /api/auth/consents", () => {
  it("records the current version, changes nothing else and audits without personal data", async () => {
    const { jar, email, uid } = await verifiedAccount();
    expect((await getUserPrivate(uid))?.consents.transfers.version).toBe(TRANSFERS_CONSENT_VERSION);
    await withOldConsent(uid);
    const before = (await privateDoc(uid).get()).data()!;

    const started = Date.now();
    const accepted = await call<{ status: string; version: string }>(consents, CONSENTS_PATH, { jar, body: { transfers: true } });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ status: "recorded", version: TRANSFERS_CONSENT_VERSION });
    expect(accepted.header("cache-control")).toContain("no-store");

    const after = (await privateDoc(uid).get()).data()!;
    expect(after.consents.transfers.version).toBe(TRANSFERS_CONSENT_VERSION);
    expect(after.consents.transfers.at.toMillis()).toBeGreaterThanOrEqual(started - 1000);
    expect(after.consents.cgu).toEqual(before.consents.cgu);
    expect(after.consents.marketing).toBe(before.consents.marketing);
    expect({ ...after, consents: undefined }).toEqual({ ...before, consents: undefined });

    const entries = await auditEntries(uid);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUid: uid, actorRole: "individual", action: "consent.transfers", target: { type: "user", id: uid }, automated: false });
    expect(entries[0]?.ipHash).toBeUndefined();
    expect(JSON.stringify(entries[0])).not.toContain(email);
  });

  it("lets a suspended member renew it (it opens nothing the suspension closes)", async () => {
    const { uid } = await verifiedAccount();
    await withOldConsent(uid);
    await setClaims(uid, { role: "individual", st: "suspended" });
    const minted = await createSessionForUid(uid);
    const jar = new Jar();
    jar.cookies.set("__Host-session", minted.cookie);
    jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
    expect((await call(consents, CONSENTS_PATH, { jar, body: { transfers: true } })).status).toBe(200);
    expect((await getUserPrivate(uid))?.consents.transfers.version).toBe(TRANSFERS_CONSENT_VERSION);
  });

  it("refuses a request without the CSRF header (403) and leaves the old version", async () => {
    const { jar, uid } = await verifiedAccount();
    await withOldConsent(uid);
    const refused = await call<ErrorBody>(consents, CONSENTS_PATH, { jar, body: { transfers: true }, csrf: false });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("csrf");
    const foreign = await call<ErrorBody>(consents, CONSENTS_PATH, { jar, body: { transfers: true }, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await getUserPrivate(uid))?.consents.transfers.version).toBe("2026-10");
    expect(await auditEntries(uid)).toEqual([]);
  });

  it("answers 400 to any other body", async () => {
    const { jar, uid } = await verifiedAccount();
    await withOldConsent(uid);
    for (const body of [{}, { transfers: false }, { transfers: "yes" }, { transfers: true, version: "2099-01-01" }]) {
      const refused = await call<ErrorBody>(consents, CONSENTS_PATH, { jar, body });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error.code).toBe("invalid_body");
    }
    expect((await getUserPrivate(uid))?.consents.transfers.version).toBe("2026-10");
  });

  it("records the first notice of a CGU change once, and answers the day it applies to the member", async () => {
    const { jar, uid } = await verifiedAccount();
    // Accepted the current text: nothing to notice, nothing written.
    const current = await call<{ status: string; version: string; effective: string }>(consents, CONSENTS_PATH, { jar, body: { cguNotice: true } });
    expect(current.status).toBe(200);
    expect((await getUserPrivate(uid))?.consents.cguNotice).toBeUndefined();

    await privateDoc(uid).update({ "consents.cgu": { version: "0.9", at: new Date("2026-10-01T10:00:00Z") } });
    const started = new Date();
    const first = await call<{ status: string; version: string; effective: string }>(consents, CONSENTS_PATH, { jar, body: { cguNotice: true } });
    expect(first.status).toBe(200);
    const notice = (await getUserPrivate(uid))?.consents.cguNotice;
    expect(notice?.version).toBe(CGU_VERSION);
    expect(notice!.at.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);
    expect(first.body).toEqual({ status: "recorded", version: CGU_VERSION, effective: cguEffectiveFor(notice!.at) });

    const again = await call<{ effective: string }>(consents, CONSENTS_PATH, { jar, body: { cguNotice: true } });
    expect(again.body.effective).toBe(first.body.effective);
    expect((await getUserPrivate(uid))?.consents.cguNotice?.at.getTime()).toBe(notice!.at.getTime());
    // Not an acknowledgement: the CGU stay to accept, and nothing is audited.
    expect((await getUserPrivate(uid))?.consents.cgu.version).toBe("0.9");
    expect(await auditEntries(uid)).toEqual([]);
  });

  it("answers 401 when signed out", async () => {
    const refused = await call<ErrorBody>(consents, CONSENTS_PATH, { jar: new Jar(), body: { transfers: true } });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("unauthenticated");
  });
});
