import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { HIDDEN_MARKER, URL_MARKER } from "@/lib/contracts/messaging";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { freezeConversation, getConversationForStaff, hideMessage, readUnreadTotal, scheduleDigest, setConversationHold, unhideMessage, unreadSummary } from "@/lib/messaging";
import { getConversation } from "@/lib/messaging/repository";
import { MESSAGING_KEYS, setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { member, send, seedListing, setState, startOk, type Member } from "./helpers";

// What the other phase 5 lots call (design §4 L1 exports): hide and restore a message with its
// evidence (L2 strong signal, L3 decisions), the staff transcript (D18), legal holds and freezes
// (L2, L3 authority requests), the unread total and the digest queue (L5).

let valkey: FakeValkey;

beforeEach(() => {
  resetRateLimiters();
  valkey = new FakeValkey();
  setMessagingValkeyForTests(valkey.asClient());
});

afterAll(() => setMessagingValkeyForTests(undefined));

const messageDoc = async (cid: string, mid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.messages).doc(mid).get()).data()!;
const evidenceDoc = async (cid: string, mid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.evidence).doc(mid).get()).data();

async function conversation(): Promise<{ buyer: Member; seller: Member; cid: string; firstId: string }> {
  const [buyer, seller] = await Promise.all([member(), member()]);
  const { id } = await seedListing(seller);
  const { cid, messageId } = await startOk(buyer, id, "Bonjour, encore dispo ?");
  return { buyer, seller, cid, firstId: messageId };
}

describe("hideMessage / unhideMessage", () => {
  it("hides a plain message (original to evidence, preview too) and restores it", async () => {
    const { seller, cid } = await conversation();
    const reply = await send(seller, cid, "Payez d'abord, sinon rien");
    const mid = reply.body.messageId;
    expect(await hideMessage(cid, mid, "report:r1")).toBe(true);
    expect(await messageDoc(cid, mid)).toMatchObject({ text: HIDDEN_MARKER, hidden: true });
    expect(await evidenceDoc(cid, mid)).toMatchObject({ text: "Payez d'abord, sinon rien", reason: "hidden" });
    expect((await getConversation(cid))!.lastMessage.preview).toBe(HIDDEN_MARKER);
    expect(await hideMessage(cid, mid, "report:r1")).toBe(false);

    expect(await unhideMessage(cid, mid)).toBe(true);
    const restored = await messageDoc(cid, mid);
    expect(restored.text).toBe("Payez d'abord, sinon rien");
    expect(restored.hidden).toBeUndefined();
    expect(await evidenceDoc(cid, mid)).toBeUndefined();
    expect((await getConversation(cid))!.lastMessage.preview).toBe("Payez d'abord, sinon rien");
    expect(await unhideMessage(cid, mid)).toBe(false);
  });

  it("keeps the masked evidence of a message with links, and masks again on restore", async () => {
    const { buyer, seller, cid, firstId } = await conversation();
    const masked = await send(seller, cid, "Voir https://arnaque.example.com/pay");
    await send(buyer, cid, "Non merci");
    const mid = masked.body.messageId;
    expect(await hideMessage(cid, mid, "decision:d1")).toBe(true);
    expect(await evidenceDoc(cid, mid)).toMatchObject({ text: "Voir https://arnaque.example.com/pay", reason: "hidden", flags: ["external_url"] });
    // Not the last message: the preview stays.
    expect((await getConversation(cid))!.lastMessage.preview).toBe("Non merci");
    expect(await unhideMessage(cid, mid)).toBe(true);
    expect((await messageDoc(cid, mid)).text).toBe(`Voir ${URL_MARKER}`);
    expect(await evidenceDoc(cid, mid)).toMatchObject({ text: "Voir https://arnaque.example.com/pay", reason: "masked" });
    expect((await messageDoc(cid, firstId)).hidden).toBeUndefined();
  });

  it("ignores unknown or malformed ids (never a path)", async () => {
    const { cid } = await conversation();
    expect(await hideMessage(cid, "AAAAAAAAAAAAAAAAAAAA", "x")).toBe(false);
    expect(await hideMessage("../../users/x", "AAAAAAAAAAAAAAAAAAAA", "x")).toBe(false);
    expect(await hideMessage(cid, "a/b", "x")).toBe(false);
    expect(await unhideMessage(cid, "AAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });
});

describe("getConversationForStaff", () => {
  it("returns the conversation, newest messages first (bounded) and the evidence of masked ones", async () => {
    const { buyer, seller, cid, firstId } = await conversation();
    const masked = await send(seller, cid, "Mon site: boutique-velo.example.com");
    await send(buyer, cid, "Merci");
    const view = await getConversationForStaff(cid, 500);
    expect(view!.conversation.cid).toBe(cid);
    expect(view!.messages.map((message) => message.text)).toEqual(["Merci", `Mon site: ${URL_MARKER}`, "Bonjour, encore dispo ?"]);
    expect(Object.keys(view!.evidence)).toEqual([masked.body.messageId]);
    expect(view!.evidence[masked.body.messageId]!.text).toBe("Mon site: boutique-velo.example.com");

    const two = await getConversationForStaff(cid, 2, { evidenceFor: [firstId] });
    expect(two!.messages).toHaveLength(2);
    expect(two!.evidence).toEqual({});
    expect(await getConversationForStaff("AAAAAAAAAAAAAAAAAAAAAA", 10)).toBeNull();
    expect(await getConversationForStaff("bad/cid", 10)).toBeNull();
  });
});

describe("legal holds and freezes", () => {
  it("adds and removes holds without touching the status", async () => {
    const { cid } = await conversation();
    expect(await setConversationHold(cid, "report:r1", true)).toBe(true);
    expect(await setConversationHold(cid, "report:r1", true)).toBe(false);
    expect(await getConversation(cid)).toMatchObject({ legalHold: ["report:r1"], status: "open" });
    expect(await setConversationHold(cid, "report:r1", false)).toBe(true);
    expect((await getConversation(cid))!.legalHold).toEqual([]);
    expect(await setConversationHold("AAAAAAAAAAAAAAAAAAAAAA", "report:r1", true)).toBe(false);
  });

  it("stays frozen while another freezing hold remains", async () => {
    const { seller, cid } = await conversation();
    await setConversationHold(cid, "report:r2", true);
    expect(await freezeConversation(cid, "authority:a1", true)).toBe(true);
    expect(await freezeConversation(cid, "authority:a2", true)).toBe(true);
    expect((await send(seller, cid, "Salam")).status).toBe(409);
    expect(await freezeConversation(cid, "authority:a1", false)).toBe(true);
    expect(await getConversation(cid)).toMatchObject({ status: "frozen", legalHold: ["report:r2", "authority:a2"] });
    expect(await freezeConversation(cid, "authority:a2", false)).toBe(true);
    expect(await getConversation(cid)).toMatchObject({ status: "open", legalHold: ["report:r2"] });
    expect((await send(seller, cid, "Salam")).status).toBe(201);
  });
});

describe("unread total and digest (lot L5)", () => {
  it("reads the total from Firestore once, then Valkey; queues digests NX", async () => {
    const { buyer, seller, cid } = await conversation();
    await send(buyer, cid, "Vous êtes là ?");
    expect(await readUnreadTotal(seller.uid)).toBe(2);
    expect(await valkey.exists(MESSAGING_KEYS.unreadInit(seller.uid))).toBe(1);
    await setState(seller, cid, { hidden: true });
    expect(await readUnreadTotal(seller.uid)).toBe(0);
    expect(await scheduleDigest(buyer.uid)).toBe(true);
    expect(await scheduleDigest(buyer.uid)).toBe(false);
  });

  it("summarizes unread conversations for the digest mail, without message text", async () => {
    const seller = await member({ displayName: "Salma Vendeuse" });
    const [a, b] = await Promise.all([member({ displayName: "Amine Acheteur" }), member({ displayName: "Badr Acheteur" })]);
    const bike = await seedListing(seller);
    const helmet = await seedListing(seller, { title: "Casque vélo" });
    await startOk(a, bike.id, "Bonjour");
    const second = await startOk(b, helmet.id, "Salam");
    await send(b, second.cid, "Toujours dispo ?");
    const summary = await unreadSummary(seller.uid);
    expect(summary).toEqual({
      total: 3,
      items: [
        { cid: second.cid, listingTitle: "Casque vélo", counterpartName: "Badr Acheteur", unread: 2 },
        { cid: expect.any(String), listingTitle: "Vélo de ville Peugeot", counterpartName: "Amine Acheteur", unread: 1 },
      ],
    });
    expect(await unreadSummary(a.uid)).toEqual({ total: 0, items: [] });
  });
});
