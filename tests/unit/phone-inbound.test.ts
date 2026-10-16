import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeHash, phoneCodeKey } from "@/lib/phone-verify/codes";
import { processInbound } from "@/lib/phone-verify/inbound";
import { CHALLENGE_TTL_SECONDS, MemoryChallengeStore } from "@/lib/phone-verify/store";
import type { InboundMessage } from "@/lib/phone-verify/webhook";

// processInbound against the in-memory store with the account, audit and mail modules mocked:
// which challenge a message selects, the transfer of a number, and the retry after a failure.

const mocks = vi.hoisted(() => ({
  claim: vi.fn(async (_uid: string, _e164: string) => ({ previousUid: null as string | null })),
  audit: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => undefined),
  capture: vi.fn(),
  users: new Map<string, { email: string; locale: "fr" | "ar" | "rif"; displayName: string }>(),
}));

vi.mock("@/lib/phone-verify/accounts", () => ({ claimVerifiedPhone: mocks.claim }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/mail", () => ({ sendMail: mocks.sendMail }));
vi.mock("@/lib/observability/capture", () => ({ captureServerException: mocks.capture }));
vi.mock("@/lib/db/repositories/users", () => ({
  getUser: async (uid: string) => {
    const user = mocks.users.get(uid);
    return user ? { displayName: user.displayName, locale: user.locale } : null;
  },
  getUserPrivate: async (uid: string) => {
    const user = mocks.users.get(uid);
    return user ? { email: user.email } : null;
  },
}));

const T0 = 1_760_000_000_000;
const NUMBER = "+212612345678";
const FROM = "212612345678";

let store: MemoryChallengeStore;
let wamids = 0;

const message = (code: string | null, from = FROM): InboundMessage => ({ wamid: `wamid.${++wamids}`, from, code });

async function pending(uid: string, code: string, e164 = NUMBER, expiresAt = T0 + CHALLENGE_TTL_SECONDS * 1000): Promise<void> {
  await store.put(uid, { phoneE164: e164, codeHash: codeHash(uid, code), codeKey: phoneCodeKey(e164, code), expiresAt });
}

const run = (items: InboundMessage[], now = T0 + 1000) => processInbound(items, { store, now });

beforeEach(() => {
  store = new MemoryChallengeStore(() => T0 + 1000);
  mocks.claim.mockClear();
  mocks.claim.mockImplementation(async () => ({ previousUid: null }));
  mocks.audit.mockClear();
  mocks.sendMail.mockClear();
  mocks.capture.mockClear();
  mocks.users.clear();
  mocks.users.set("alice", { email: "alice@example.com", locale: "fr", displayName: "Alice" });
  mocks.users.set("bob", { email: "bob@example.com", locale: "ar", displayName: "Bob" });
});

describe("processInbound", () => {
  it("verifies the account whose code is in the message, not the latest start for the number", async () => {
    await pending("alice", "111111");
    await pending("bob", "222222");
    expect(await run([message("111111")])).toEqual({ received: 1, duplicates: 0, verified: 1, transferred: 0, ignored: 0, failed: 0 });
    expect(mocks.claim).toHaveBeenCalledWith("alice", NUMBER);
    expect(await store.getByUid("alice")).toBeNull();
    expect(await store.getByUid("bob")).not.toBeNull();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "phone.verified", target: { type: "user", id: "alice" } }));
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ template: "phoneVerified", to: "alice@example.com", locale: "fr", priority: "security" }));
    // Bob's own code still works afterwards.
    expect((await run([message("222222")])).verified).toBe(1);
    expect(mocks.claim).toHaveBeenLastCalledWith("bob", NUMBER);
  });

  it("ignores a wrong code, a code from another number, a missing code and an expired challenge", async () => {
    await pending("alice", "111111");
    const summary = await run([message("999999"), message("111111", "212699999999"), message(null), { wamid: "wamid.foreign", from: "33612345678", code: "111111" }]);
    expect(summary).toMatchObject({ verified: 0, ignored: 4, failed: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(await store.getByUid("alice")).not.toBeNull();
    await pending("carol", "333333", "+212700000000", T0 - 1);
    mocks.users.set("carol", { email: "carol@example.com", locale: "rif", displayName: "Carol" });
    expect(await run([message("333333", "212700000000")])).toMatchObject({ verified: 0, ignored: 1 });
  });

  it("transfers a number verified elsewhere: audit entry and removal mail for the previous holder", async () => {
    await pending("bob", "222222");
    mocks.claim.mockImplementationOnce(async () => ({ previousUid: "alice" }));
    expect(await run([message("222222")])).toMatchObject({ verified: 1, transferred: 1, ignored: 0, failed: 0 });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "phone.verified", actorUid: "bob", target: { type: "user", id: "bob" } }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "phone.transferred", actorUid: "bob", actorRole: "system", automated: true, target: { type: "user", id: "alice" }, reason: "number verified by bob" }));
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ template: "phoneRemoved", to: "alice@example.com", locale: "fr", priority: "security", data: { displayName: "Alice", phone: "06 12 34 56 78" } }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ template: "phoneRemoved", idempotencyKey: expect.stringMatching(/^phoneRemoved:alice:/) }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ template: "phoneVerified", to: "bob@example.com", locale: "ar" }));
  });

  it("processes a wamid once, but lets the retry through after a failure", async () => {
    await pending("alice", "111111");
    mocks.claim.mockRejectedValueOnce(new Error("firestore unavailable"));
    const first = message("111111");
    expect(await run([first])).toMatchObject({ verified: 0, failed: 1 });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(await store.getByUid("alice")).not.toBeNull();
    // Meta retries the same message id: it is processed again and succeeds this time.
    expect(await run([first])).toMatchObject({ verified: 1, duplicates: 0, failed: 0 });
    // A third delivery is a duplicate.
    expect(await run([first])).toMatchObject({ verified: 0, duplicates: 1 });
  });

  it("records the verification even when the confirmation mail fails", async () => {
    await pending("alice", "111111");
    mocks.sendMail.mockRejectedValueOnce(new Error("queue down"));
    expect(await run([message("111111")])).toMatchObject({ verified: 1, failed: 0 });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    // No account document: nothing to send, still verified.
    await pending("ghost", "444444", "+212611111111");
    expect(await run([message("444444", "212611111111")])).toMatchObject({ verified: 1, failed: 0 });
  });
});
