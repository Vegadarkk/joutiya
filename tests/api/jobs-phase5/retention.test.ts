import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, describe, expect, it, vi } from "vitest";

// retention-purge, phase 5 steps (design D22) against the Firestore emulator: real queries and
// transactions. Conversations past purgeAt without a hold and not frozen lose their messages,
// their evidence and then the document; a message newer than the purgeAt read (and its evidence)
// is never deleted, and keeps the conversation. Reports (closed), decisions (no open appeal),
// authority requests (closed), AI proposals (no hold; one grounding a live decision follows it),
// auditLogs past purgeAt, and userBlocks of accounts that no longer exist.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { audit, auditPurgeAt } from "@/lib/audit";
import { writeUserBlocksCursor } from "@/lib/db/repositories/retention";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { retentionPurge } from "@/worker/jobs/retention-purge";
import { member } from "../listings/helpers";

const DAY = 86_400_000;
const NOW = new Date();
const PAST = Timestamp.fromMillis(NOW.getTime() - DAY);
const FUTURE = Timestamp.fromMillis(NOW.getTime() + 300 * DAY);
const OLD = Timestamp.fromMillis(NOW.getTime() - 400 * DAY);
const RUN = `l5-${NOW.getTime().toString(36)}`;
const id = (name: string) => `${RUN}-${name}`;

const col = (name: string) => db().collection(name);
const conversation = (cid: string) => col(COLLECTIONS.conversations).doc(cid);
const exists = async (path: string) => (await db().doc(path).get()).exists;

async function seedConversation(name: string, data: Record<string, unknown>, messages: Record<string, Timestamp>, evidence: string[] = []): Promise<string> {
  const cid = id(name);
  await conversation(cid).set({ status: "open", legalHold: [], purgeAt: PAST, updatedAt: OLD, ...data });
  for (const [mid, createdAt] of Object.entries(messages)) await conversation(cid).collection(COLLECTIONS.messages).doc(mid).set({ senderUid: "u", type: "text", text: "Bonjour ⟦url⟧", createdAt });
  for (const mid of evidence) await conversation(cid).collection(COLLECTIONS.evidence).doc(mid).set({ text: "Bonjour https://exemple.test", flags: ["external_url"], reason: "masked", createdAt: OLD });
  return cid;
}

let liveUid: string;
let result: Awaited<ReturnType<typeof retentionPurge>>;

beforeAll(async () => {
  resetServerEnv();
  liveUid = (await member()).uid;

  await seedConversation("purge", {}, { m1: OLD, m2: OLD }, ["m1", "gone"]);
  await seedConversation("held", { legalHold: ["report:r1"] }, { m1: OLD });
  await seedConversation("frozen", { status: "frozen", legalHold: [] }, { m1: OLD });
  await seedConversation("fresh", { purgeAt: FUTURE }, { m1: OLD });
  // A message written after the purgeAt read (the job's cutoff): it and its evidence stay.
  await seedConversation("racing", {}, { m1: OLD, late: Timestamp.fromMillis(NOW.getTime() - 1000) }, ["m1", "late"]);

  await col(COLLECTIONS.reports).doc(id("r-closed")).set({ status: "dismissed", purgeAt: PAST });
  await col(COLLECTIONS.reports).doc(id("r-open")).set({ status: "open", purgeAt: PAST });
  await col(COLLECTIONS.reports).doc(id("r-fresh")).set({ status: "actioned", purgeAt: FUTURE });
  await col(COLLECTIONS.moderationDecisions).doc(id("d-old")).set({ purgeAt: PAST, appeal: { status: "upheld", openedAt: OLD } });
  await col(COLLECTIONS.moderationDecisions).doc(id("d-appeal")).set({ purgeAt: PAST, appeal: { status: "open", openedAt: OLD } });
  await col(COLLECTIONS.moderationDecisions).doc(id("d-live")).set({ purgeAt: FUTURE });
  await col(COLLECTIONS.authorityRequests).doc(id("a-closed")).set({ status: "closed", purgeAt: PAST });
  await col(COLLECTIONS.authorityRequests).doc(id("a-open")).set({ status: "open", purgeAt: PAST });
  await col(COLLECTIONS.aiDecisions).doc(id("ai-plain")).set({ purgeAt: PAST, legalHold: [] });
  await col(COLLECTIONS.aiDecisions).doc(id("ai-grounds-live")).set({ purgeAt: PAST, legalHold: [], decisionId: id("d-live") });
  await col(COLLECTIONS.aiDecisions).doc(id("ai-grounds-old")).set({ purgeAt: PAST, legalHold: [], decisionId: id("d-old") });
  await col(COLLECTIONS.aiDecisions).doc(id("ai-held")).set({ purgeAt: PAST, legalHold: ["report:r1"] });
  await col(COLLECTIONS.auditLogs).doc(id("audit-old")).set({ action: "x", at: OLD, purgeAt: PAST });
  await col(COLLECTIONS.auditLogs).doc(id("audit-kept")).set({ action: "x", at: OLD });
  await col(COLLECTIONS.userBlocks).doc(id("orphan-uid")).set({ uids: ["someone"], updatedAt: OLD });
  await col(COLLECTIONS.userBlocks).doc(liveUid).set({ uids: ["someone"], updatedAt: OLD });
  // Entries written through audit() carry purgeAt = at + 5 years (audit D1a-06): a six-year-old one goes, a fresh one stays.
  for (const [name, at] of [["audit-api-old", new Date(NOW.getTime() - 6 * 365 * DAY)], ["audit-api-fresh", NOW]] as const) {
    await audit({ actorUid: "system", actorRole: "system", action: "retention.test", target: { type: "test", id: id(name) }, automated: true, at });
  }
  // Start the rotating scan right before this run's documents (others may exist in a shared emulator).
  await writeUserBlocksCursor(RUN);

  result = await retentionPurge(NOW, { store: new MemoryObjectStore() });
});

describe("retention-purge phase 5 on the emulator", () => {
  it("purges an idle conversation with its messages and evidence", async () => {
    const cid = id("purge");
    expect(await exists(`conversations/${cid}`)).toBe(false);
    for (const path of ["messages/m1", "messages/m2", "evidence/m1", "evidence/gone"]) expect(await exists(`conversations/${cid}/${path}`)).toBe(false);
    expect(result.conversations).toBeGreaterThanOrEqual(1);
    expect(result.messages).toBeGreaterThanOrEqual(3);
    expect(result.evidence).toBeGreaterThanOrEqual(3);
  });

  it("keeps held, frozen and active conversations untouched", async () => {
    for (const name of ["held", "frozen", "fresh"]) {
      expect(await exists(`conversations/${id(name)}`)).toBe(true);
      expect(await exists(`conversations/${id(name)}/messages/m1`)).toBe(true);
    }
  });

  it("never deletes a message newer than the purgeAt it read, nor its evidence, nor its conversation", async () => {
    const cid = id("racing");
    expect(await exists(`conversations/${cid}/messages/m1`)).toBe(false);
    expect(await exists(`conversations/${cid}/evidence/m1`)).toBe(false);
    expect(await exists(`conversations/${cid}/messages/late`)).toBe(true);
    expect(await exists(`conversations/${cid}/evidence/late`)).toBe(true);
    expect(await exists(`conversations/${cid}`)).toBe(true);
  });

  it("purges closed reports, decisions without an open appeal and closed authority requests after 5 years", async () => {
    expect(await exists(`reports/${id("r-closed")}`)).toBe(false);
    expect(await exists(`reports/${id("r-open")}`)).toBe(true);
    expect(await exists(`reports/${id("r-fresh")}`)).toBe(true);
    expect(await exists(`moderationDecisions/${id("d-old")}`)).toBe(false);
    expect(await exists(`moderationDecisions/${id("d-appeal")}`)).toBe(true);
    expect(await exists(`moderationDecisions/${id("d-live")}`)).toBe(true);
    expect(await exists(`authorityRequests/${id("a-closed")}`)).toBe(false);
    expect(await exists(`authorityRequests/${id("a-open")}`)).toBe(true);
  });

  it("purges AI proposals after 12 months unless held or grounding a live decision (whose purgeAt they take)", async () => {
    expect(await exists(`aiDecisions/${id("ai-plain")}`)).toBe(false);
    expect(await exists(`aiDecisions/${id("ai-grounds-old")}`)).toBe(false);
    expect(await exists(`aiDecisions/${id("ai-held")}`)).toBe(true);
    const grounded = await col(COLLECTIONS.aiDecisions).doc(id("ai-grounds-live")).get();
    expect(grounded.exists).toBe(true);
    expect((grounded.get("purgeAt") as Timestamp).toMillis()).toBe(FUTURE.toMillis());
  });

  it("purges auditLogs past purgeAt (entries written before phase 5, without one, stay) and userBlocks of purged accounts", async () => {
    expect(await exists(`auditLogs/${id("audit-old")}`)).toBe(false);
    expect(await exists(`auditLogs/${id("audit-kept")}`)).toBe(true);
    const written = async (name: string) => (await col(COLLECTIONS.auditLogs).where("target.id", "==", id(name)).get()).docs;
    expect(await written("audit-api-old")).toHaveLength(0);
    const [fresh] = await written("audit-api-fresh");
    expect((fresh?.get("purgeAt") as Timestamp).toMillis()).toBe(auditPurgeAt(NOW).getTime());
    expect(auditPurgeAt(NOW).getUTCFullYear()).toBe(NOW.getUTCFullYear() + 5);
    expect(await exists(`userBlocks/${id("orphan-uid")}`)).toBe(false);
    expect(await exists(`userBlocks/${liveUid}`)).toBe(true);
    expect(result.failed).toBe(0);
  });

  it("records one audit entry per purged collection", async () => {
    const snapshot = await col(COLLECTIONS.auditLogs).where("action", "==", "retention.purge").where("at", "==", Timestamp.fromDate(NOW)).get();
    const targets = snapshot.docs.map((doc) => (doc.get("target") as { id: string }).id).sort();
    expect(targets).toEqual(expect.arrayContaining(["aiDecisions", "authorityRequests", "conversations", "decisions", "evidence", "messages", "reports", "userBlocks"]));
  });
});
