import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import { renderMail } from "@/lib/mail/render";
import type { TemplateMail } from "@/lib/mail/types";
import { MESSAGING_KEYS, setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { sendMessageDigests } from "@/worker/jobs/message-digest";
import { DigestValkeyFake } from "../../unit/jobs-phase5-fake-valkey";
import { markRead, member, send, seedListing, startOk, unread, type Member } from "../messaging/helpers";

// message-digest (design D21) end to end on the emulators: a first message queues the seller
// (scheduleDigest from the real send path), the job reads the unread state from Firestore and the
// account documents, and queues one bulk `newMessages` mail without the message text. Reading the
// badge (`msg:seen`) or the conversation, or turning the mail off, means no mail.

const sendMailMock = vi.mocked(sendMail);
const MIN = 60_000;
let valkey: DigestValkeyFake;

beforeEach(() => {
  resetServerEnv();
  resetRateLimiters();
  valkey = new DigestValkeyFake();
  setMessagingValkeyForTests(valkey.asClient());
  sendMailMock.mockClear();
});

afterAll(() => setMessagingValkeyForTests(undefined));

const later = (minutes: number) => new Date(Date.now() + minutes * MIN);
const run = (minutes = 31) => sendMessageDigests(later(minutes), { valkey: valkey as never });

async function pair(): Promise<{ buyer: Member; seller: Member; listingId: string }> {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const { id } = await seedListing(seller);
  return { buyer, seller, listingId: id };
}

function mailsTo(email: string): TemplateMail[] {
  return sendMailMock.mock.calls.map(([mail]) => mail as TemplateMail).filter((mail) => mail.to === email);
}

describe("message-digest on the emulators", () => {
  it("one grouped mail 30 minutes after the first unread message, with the count and the conversation, never the text", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId, "Bonjour, je vous paie par virement, voici mon RIB");
    expect(valkey.score(seller.uid)).toBeDefined();
    expect((await send(buyer, cid, "Toujours disponible ?")).status).toBe(201);

    // Not due yet.
    expect(await run(10)).toMatchObject({ sent: 0 });
    const result = await run();
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    const [mail] = mailsTo(seller.email);
    expect(mail).toMatchObject({ template: "newMessages", priority: "bulk", locale: "fr" });
    expect(mail!.data).toEqual({ displayName: "Salma Vendeuse", count: 2, conversations: [{ listingTitle: "Vélo de ville Peugeot", counterpartName: "Youssef Acheteur" }] });
    const rendered = renderMail(mail!);
    for (const body of [rendered.text, rendered.html]) {
      expect(body).not.toContain("virement");
      expect(body).not.toContain("disponible");
      expect(body).toContain("/fr/messages");
    }
    // The buyer has nothing unread: never queued.
    expect(mailsTo(buyer.email)).toEqual([]);
    expect(valkey.score(seller.uid)).toBeUndefined();
    expect(valkey.ttlMs(MESSAGING_KEYS.digestLast(seller.uid))).toBeGreaterThan(5 * 3_600_000);
  });

  it("no mail when the account looked at its badge or read the conversation meanwhile", async () => {
    const { buyer, seller, listingId } = await pair();
    await startOk(buyer, listingId);
    expect((await unread(seller)).body.total).toBe(1);
    expect(await run()).toMatchObject({ active: 1, sent: 0 });

    const other = await pair();
    const { cid } = await startOk(other.buyer, other.listingId);
    expect((await markRead(other.seller, cid)).status).toBe(204);
    await valkey.del(MESSAGING_KEYS.seen(other.seller.uid));
    expect(await run()).toMatchObject({ read: 1, sent: 0 });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("no mail when the member turned the new-messages mail off", async () => {
    const { buyer, seller, listingId } = await pair();
    await db().collection(COLLECTIONS.users).doc(seller.uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc).update({ notifications: { messagesEmail: false } });
    await startOk(buyer, listingId);
    expect(await run()).toMatchObject({ optedOut: 1, sent: 0 });
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
