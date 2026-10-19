import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import type { DecideResponse } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { resetServerEnv } from "@/lib/env";
import { MessagingBus, setMessagingBusForTests } from "@/lib/messaging/bus";
import { setEventPublisherForTests } from "@/lib/messaging/events";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { FakePubSub } from "../../unit/messaging-fake-pubsub";
import { adminCall, staff, type Staff } from "../admin/decisions/helpers";
import { listingNotice, member, publishedListing, report } from "../reports/helpers";
import { openStream, type OpenStream } from "./helpers";

// A ban or a suspension (design D2 security, D14) publishes `revoked` on the account's channel:
// its open streams end at once, and the revoked session cannot open a new one.

let moderator: Staff;
let adminStaff: Staff;
let pubsub: FakePubSub;
let bus: MessagingBus;
const streams: OpenStream[] = [];

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposal: async () => null });
  moderator = await staff("moderator");
  adminStaff = await staff("admin");
});

beforeEach(() => {
  resetRateLimiters();
  pubsub = new FakePubSub();
  bus = new MessagingBus(pubsub);
  setMessagingBusForTests(bus);
  setEventPublisherForTests(pubsub.publish);
});

afterEach(() => {
  for (const stream of streams.splice(0)) stream.abort();
});

afterAll(() => {
  setMessagingBusForTests(undefined);
  setEventPublisherForTests(undefined);
});

/** Revocation is second-granular: a session minted in the same second as the revocation survives it. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

async function liveStream(who: Parameters<typeof openStream>[0]): Promise<OpenStream> {
  const stream = await openStream(who);
  streams.push(stream);
  expect(stream.status).toBe(200);
  await stream.until('"ready"');
  return stream;
}

describe("revocation of the live stream", () => {
  it("a suspension closes the seller's open streams at once; the revoked session cannot reopen", async () => {
    const { id, seller } = await publishedListing();
    const bystander = await member();
    const [first, second, other] = [await liveStream(seller), await liveStream(seller), await liveStream(bystander)];
    expect((await report(listingNotice(id, "scam"), { as: bystander })).status).toBe(201);
    await nextSecond();

    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", {
      as: moderator,
      body: { target: `listing:${id}`, templateId: "listing.remove.scam", sanction: { action: "suspend_account", durationDays: 7 } },
    });
    expect(decided.status).toBe(201);
    for (const stream of [first, second]) {
      await stream.end();
      expect(stream.events()).toEqual([{ type: "ready" }, { type: "revoked" }]);
    }
    expect(other.ended()).toBe(false);
    expect(pubsub.eventsFor(seller.uid)).toEqual([{ type: "revoked" }]);
    expect(pubsub.eventsFor(bystander.uid)).toEqual([]);
    expect(bus.stats()).toEqual({ streams: 1, accounts: 1 });
    // setClaims revoked the session: the browser must sign in again (then reads, suspended, D9).
    expect((await openStream(seller)).status).toBe(401);
  });

  it("a ban does the same", async () => {
    const { seller } = await publishedListing();
    const stream = await liveStream(seller);
    await nextSecond();
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", {
      as: adminStaff,
      body: { target: `user:${seller.uid}`, templateId: "user.ban", details: "Escroqueries répétées malgré deux suspensions." },
    });
    expect(decided.status).toBe(201);
    await stream.end();
    expect(stream.events()).toEqual([{ type: "ready" }, { type: "revoked" }]);
    expect((await openStream(seller)).status).toBe(401);
  });
});
