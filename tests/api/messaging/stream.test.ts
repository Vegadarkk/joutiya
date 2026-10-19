import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import type { MessagingEvent } from "@/lib/contracts/messaging";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { freezeConversation, hideMessage, publishRevoked, setConversationHold, unhideMessage } from "@/lib/messaging";
import { MessagingBus, setMessagingBusForTests } from "@/lib/messaging/bus";
import { eventChannel, setEventPublisherForTests } from "@/lib/messaging/events";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { FakePubSub } from "../../unit/messaging-fake-pubsub";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { markRead, member, openStream, seedListing, send, setState, spend, startOk, unread, type Member, type OpenStream } from "./helpers";

// GET /api/messages/stream and the publishers of every messaging write (design D2, D9) on the
// emulators, with an in-memory pub/sub in place of valkey-queue: headers and first frames, auth
// (revoked sessions, staff, suspended members), the open limiter and the caps, Last-Event-ID,
// events of send / read / archive / block / hide / freeze reaching both sides (ids only), and the
// stream closed on `revoked` or when the client leaves.

let pubsub: FakePubSub;
let bus: MessagingBus;
const streams: OpenStream[] = [];

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  pubsub = new FakePubSub();
  bus = new MessagingBus(pubsub);
  setMessagingBusForTests(bus);
  setEventPublisherForTests(pubsub.publish);
});

afterEach(() => {
  for (const stream of streams.splice(0)) stream.abort();
});

afterAll(() => {
  setMessagingValkeyForTests(undefined);
  setMessagingBusForTests(undefined);
  setEventPublisherForTests(undefined);
});

async function open(who: Member | undefined, headers: Record<string, string> = {}): Promise<OpenStream> {
  const stream = await openStream(who, headers);
  streams.push(stream);
  return stream;
}

async function pair(): Promise<{ buyer: Member; seller: Member; cid: string; listingId: string }> {
  const [buyer, seller] = await Promise.all([member(), member()]);
  const { id } = await seedListing(seller);
  const { cid } = await startOk(buyer, id);
  return { buyer, seller, cid, listingId: id };
}

async function withClaims(who: Member, claims: Parameters<typeof setClaims>[1]): Promise<Member> {
  await setClaims(who.uid, claims);
  const minted = await createSessionForUid(who.uid);
  who.jar.cookies.set("__Host-session", minted.cookie);
  who.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return who;
}

/** Revocation is second-granular: a session minted in the same second as the revocation survives it. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

/** Event types published to `uid` since `from` (an index into pubsub.published). */
const typesFor = (uid: string, from: number) => pubsub.published.slice(from).filter((delivery) => delivery.uid === uid).map((delivery) => delivery.event.type);

describe("GET /api/messages/stream", () => {
  it("answers an event stream: headers, retry, ready, then the account's events (ids only)", async () => {
    const { buyer, seller, cid } = await pair();
    expect((await unread(seller)).body).toEqual({ total: 1 });
    const stream = await open(seller);
    expect(stream.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(stream.response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
    expect(await stream.until('"ready"')).toMatch(/^retry: \d{4}\n\n/);
    expect(pubsub.channels).toEqual(new Set([eventChannel(seller.uid)]));

    const sent = await send(buyer, cid, "Je passe ce soir, voici mon lien https://exemple.ma/x");
    const text = await stream.until('"unread"');
    expect(stream.events()).toEqual([{ type: "ready" }, { type: "message", cid, mid: sent.body.messageId, at: expect.any(Number) }, { type: "unread", total: 2 }]);
    expect(text).toMatch(/id: [A-Za-z0-9_-]+\.3\ndata: \{"type":"unread"/);
    expect(text).not.toContain("ce soir");
  });

  it("starts with resync when the browser comes back with Last-Event-ID", async () => {
    const { seller } = await pair();
    const stream = await open(seller, { "last-event-id": "abc.7" });
    await stream.until("data:");
    expect(stream.events()).toEqual([{ type: "resync" }]);
  });

  it("refuses without a session (401), a revoked session (401), staff (403); a suspended member opens it (D9)", async () => {
    const { seller } = await pair();
    expect((await open(undefined)).status).toBe(401);
    const staleCookie = seller.jar.cookies.get("__Host-session")!;
    await nextSecond();
    await withClaims(seller, { role: "individual", st: "suspended" });
    const suspended = await open(seller);
    expect(suspended.status).toBe(200);
    seller.jar.cookies.set("__Host-session", staleCookie);
    expect((await open(seller)).status).toBe(401);
    const moderator = await withClaims(await member(), { role: "moderator" });
    expect((await open(moderator)).status).toBe(403);
  });

  it("limits opens per account (429), caps streams per account (429) and answers 503 without Valkey", async () => {
    const { seller, buyer } = await pair();
    await spend("messages.stream.uid", seller.uid);
    const limited = await open(seller);
    expect(limited.status).toBe(429);
    expect((await limited.response.json()).error.code).toBe("rate_limited");

    setMessagingBusForTests(new MessagingBus(pubsub, { perUid: 1, total: 10, readyTimeoutMs: 10 }));
    expect((await open(buyer)).status).toBe(200);
    expect((await open(buyer)).status).toBe(429);

    setMessagingBusForTests(null);
    const none = await open(buyer);
    expect(none.status).toBe(503);
    expect((await none.response.json()).error.code).toBe("unavailable");

    setMessagingBusForTests(bus);
    pubsub.failing = true;
    expect((await open(buyer)).status).toBe(503);
    // Valkey down breaks nothing else: the message is sent, its event is dropped (logged).
    expect((await send(seller, (await startOk(buyer, (await seedListing(seller)).id)).cid, "Oui")).status).toBe(201);
  });

  it("ends on revoked, and when the client leaves; the subscription goes with the last stream", async () => {
    const { buyer, seller } = await pair();
    const [one, two] = [await open(seller), await open(seller)];
    const other = await open(buyer);
    await Promise.all([one.until('"ready"'), two.until('"ready"'), other.until('"ready"')]);
    expect(bus.stats()).toEqual({ streams: 3, accounts: 2 });

    await publishRevoked(seller.uid);
    for (const stream of [one, two]) {
      await stream.end();
      expect(stream.events()).toEqual([{ type: "ready" }, { type: "revoked" }]);
    }
    expect(other.ended()).toBe(false);
    other.abort();
    await other.end();
    expect(bus.stats()).toEqual({ streams: 0, accounts: 0 });
    await vi.waitFor(() => expect(pubsub.channels.size).toBe(0));
  });
});

describe("publishers (after each committed write, D2)", () => {
  it("send, read, archive, delete for me and block reach the right accounts", async () => {
    const { buyer, seller, cid } = await pair();
    expect(typesFor(seller.uid, 0)).toEqual(["message"]);
    expect(typesFor(buyer.uid, 0)).toEqual(["message"]);
    await unread(seller);

    let mark = pubsub.published.length;
    const reply = await send(seller, cid, "Oui, il est là");
    // The buyer's badge was never read (untrusted hash): no total rides along, the page asks for it.
    expect(pubsub.eventsFor(buyer.uid).at(-1)).toEqual({ type: "message", cid, mid: reply.body.messageId, at: expect.any(Number) });
    expect(typesFor(buyer.uid, mark)).toEqual(["message"]);
    expect(typesFor(seller.uid, mark)).toEqual(["message"]);

    mark = pubsub.published.length;
    await markRead(seller, cid);
    expect(typesFor(buyer.uid, mark)).toEqual(["read"]);
    expect(pubsub.published.slice(mark).filter((delivery) => delivery.uid === seller.uid).map((delivery) => delivery.event)).toEqual([
      { type: "conversation", cid, at: expect.any(Number) },
      { type: "unread", total: 0 },
    ]);
    // Nothing unread any more: no write, no receipt.
    mark = pubsub.published.length;
    await markRead(seller, cid);
    expect(pubsub.published.length).toBe(mark);

    await setState(seller, cid, { archived: true });
    expect(typesFor(seller.uid, mark)).toEqual(["conversation"]);
    expect(typesFor(buyer.uid, mark)).toEqual([]);
    mark = pubsub.published.length;
    await setState(buyer, cid, { hidden: true });
    expect(typesFor(buyer.uid, mark)).toEqual(["conversation"]);
    expect(typesFor(seller.uid, mark)).toEqual([]);

    mark = pubsub.published.length;
    await setState(seller, cid, { blocked: true });
    expect(typesFor(seller.uid, mark)).toEqual(["conversation"]);
    expect(typesFor(buyer.uid, mark)).toEqual(["conversation"]);
  });

  it("moderation hides and restores, freezes and reopens; a plain legal hold says nothing", async () => {
    const { buyer, seller, cid } = await pair();
    const reply = await send(seller, cid, "Envoyez l'acompte");
    const mid = reply.body.messageId;
    const updated: MessagingEvent = { type: "message_updated", cid, mid, at: expect.any(Number) as number };

    let mark = pubsub.published.length;
    expect(await hideMessage(cid, mid, "report:r1")).toBe(true);
    expect(await unhideMessage(cid, mid)).toBe(true);
    expect(pubsub.published.slice(mark).map((delivery) => [delivery.uid, delivery.event])).toEqual([
      [buyer.uid, updated],
      [seller.uid, updated],
      [buyer.uid, updated],
      [seller.uid, updated],
    ]);

    mark = pubsub.published.length;
    expect(await setConversationHold(cid, "report:r1", true)).toBe(true);
    expect(pubsub.published.length).toBe(mark);
    expect(await freezeConversation(cid, "authority:a1", true)).toBe(true);
    expect(typesFor(buyer.uid, mark)).toEqual(["conversation"]);
    expect(typesFor(seller.uid, mark)).toEqual(["conversation"]);
    // A second freezing hold changes nothing visible; releasing the last one reopens.
    mark = pubsub.published.length;
    expect(await freezeConversation(cid, "authority:a2", true)).toBe(true);
    expect(await freezeConversation(cid, "authority:a1", false)).toBe(true);
    expect(pubsub.published.length).toBe(mark);
    expect(await freezeConversation(cid, "authority:a2", false)).toBe(true);
    expect(typesFor(buyer.uid, mark)).toEqual(["conversation"]);
  });
});
