import { Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { beforeAll, describe, expect, it, vi } from "vitest";

// retention-purge, closed accounts step (phase 5 D26, lot L7) against the emulators: a closed
// account past purgeAt loses its Auth user, users/{uid}, its private account document and its
// emailIndex entry; the civil identity, and a ban's e-mail block, stay in users/{uid}/private/identity
// until identityPurgeAt, then go. A legal hold keeps everything; an account not yet due is left alone.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { emailNormHash } from "@/lib/db/repositories/users";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { retentionPurge } from "@/worker/jobs/retention-purge";
import { member, type Member } from "../listings/helpers";

const DAY = 86_400_000;
const NOW = new Date();
const PAST = Timestamp.fromMillis(NOW.getTime() - DAY);
const FUTURE = Timestamp.fromMillis(NOW.getTime() + 300 * DAY);
const LATER = Timestamp.fromMillis(NOW.getTime() + 4 * 365 * DAY);
const RUN = `l7-${NOW.getTime().toString(36)}`;

const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);
const privateRef = (uid: string, doc: string = COLLECTIONS.userPrivateDoc) => userRef(uid).collection(COLLECTIONS.userPrivate).doc(doc);
const indexRef = (email: string) => db().collection(COLLECTIONS.emailIndex).doc(emailNormHash(email));
const exists = async (ref: DocumentReference) => (await ref.get()).exists;
async function authExists(uid: string): Promise<boolean> {
  try {
    await auth().getUser(uid);
    return true;
  } catch {
    return false;
  }
}

/** A member closed a year ago (or as given), as closeAccount leaves it. */
async function closed(status: "closed" | "banned", account: Record<string, unknown> = {}): Promise<Member> {
  const who = await member();
  await userRef(who.uid).update({ status });
  await privateRef(who.uid).update({ closedAt: Timestamp.fromMillis(NOW.getTime() - 366 * DAY), purgeAt: PAST, identityPurgeAt: LATER, ...account });
  await auth().updateUser(who.uid, { disabled: true });
  return who;
}

let plain: Member;
let banned: Member;
let held: Member;
let fresh: Member;
let result: Awaited<ReturnType<typeof retentionPurge>>;
const identityUid = `${RUN}-identity`;
const identityEmail = `${RUN}-identity@example.com`;
const heldIdentityUid = `${RUN}-identity-held`;

beforeAll(async () => {
  resetServerEnv();
  plain = await closed("closed");
  banned = await closed("banned", { legalName: "Salma Bennani" });
  held = await closed("closed", { legalHold: ["authority:a-l7"] });
  fresh = await closed("closed", { purgeAt: FUTURE });
  // An identity kept for a ban four years ago, now due, with the e-mail block it kept; and a held one.
  await privateRef(identityUid, COLLECTIONS.userIdentityDoc).set({ closedAt: Timestamp.fromMillis(NOW.getTime() - 5 * 365 * DAY), purgeAt: PAST, emailNormHash: emailNormHash(identityEmail), banned: true, legalHold: [] });
  await indexRef(identityEmail).set({ uid: identityUid, createdAt: PAST });
  await privateRef(heldIdentityUid, COLLECTIONS.userIdentityDoc).set({ closedAt: PAST, purgeAt: PAST, banned: false, legalHold: ["authority:a-l7"] });

  result = await retentionPurge(NOW, { store: new MemoryObjectStore() });
});

describe("retention-purge closed accounts on the emulators", () => {
  it("purges a closed account past purgeAt: Auth user, account documents, e-mail index", async () => {
    expect(await authExists(plain.uid)).toBe(false);
    expect(await exists(userRef(plain.uid))).toBe(false);
    expect(await exists(privateRef(plain.uid))).toBe(false);
    expect(await exists(privateRef(plain.uid, COLLECTIONS.userIdentityDoc))).toBe(false);
    expect(await exists(indexRef(plain.email))).toBe(false);
    expect(result.accounts).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);
  });

  it("keeps a banned account's identity and e-mail block until identityPurgeAt", async () => {
    expect(await authExists(banned.uid)).toBe(false);
    expect(await exists(userRef(banned.uid))).toBe(false);
    expect(await exists(privateRef(banned.uid))).toBe(false);
    const identity = (await privateRef(banned.uid, COLLECTIONS.userIdentityDoc).get()).data()!;
    expect(identity).toMatchObject({ legalName: "Salma Bennani", emailNormHash: emailNormHash(banned.email), banned: true, legalHold: [] });
    expect((identity.purgeAt as Timestamp).toMillis()).toBe(LATER.toMillis());
    expect((await indexRef(banned.email).get()).get("uid")).toBe(banned.uid);
    // Nothing else about the account survives in the identity document.
    expect(Object.keys(identity).sort()).toEqual(["banned", "closedAt", "emailNormHash", "legalHold", "legalName", "purgeAt"]);
    const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", banned.uid).where("action", "==", "account.purge").get();
    expect(audits.docs.map((doc) => doc.get("reason"))).toEqual(["identity kept until identityPurgeAt"]);
  });

  it("leaves a held account and one not yet due untouched", async () => {
    for (const who of [held, fresh]) {
      expect(await authExists(who.uid)).toBe(true);
      expect(await exists(userRef(who.uid))).toBe(true);
      expect(await exists(privateRef(who.uid))).toBe(true);
      expect(await exists(indexRef(who.email))).toBe(true);
    }
    expect(result.held).toBeGreaterThanOrEqual(2);
  });

  it("purges an identity past its purgeAt with the e-mail block it kept, unless held", async () => {
    expect(await exists(privateRef(identityUid, COLLECTIONS.userIdentityDoc))).toBe(false);
    expect(await exists(indexRef(identityEmail))).toBe(false);
    expect(await exists(privateRef(heldIdentityUid, COLLECTIONS.userIdentityDoc))).toBe(true);
    expect(result.identities).toBeGreaterThanOrEqual(1);
    const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", identityUid).get();
    expect(audits.docs.map((doc) => doc.get("action"))).toEqual(["account.identity_purge"]);
  });
});
