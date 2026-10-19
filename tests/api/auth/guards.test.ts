import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/auth/guards";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import type * as Turnstile from "@/lib/security/turnstile";
import { POST as action } from "@/app/api/auth/action/route";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as inbox, POST as startConversation } from "@/app/api/conversations/route";
import { GET as unread } from "@/app/api/messages/unread/route";
import { POST as profile } from "@/app/api/auth/profile/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { CONSENTS, Jar, ORIGIN, PASSWORD, call, lastMail, oobCodeOf, uniqueEmail, type ErrorBody, type SignedInBody } from "./helpers";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

// Guards on a suspended account (§6 "Contrôle d'accès"): the session is refused everywhere except
// on the routes that opt in (reading conversations, export, appeal).

async function verifiedAccount() {
  const jar = new Jar();
  const email = uniqueEmail("gs");
  expect((await call(signup, "/api/auth/signup", { jar, body: { email, password: PASSWORD, displayName: "Suspended Soon", locale: "fr", consents: CONSENTS, turnstileToken: "t" } })).status).toBe(202);
  const verified = await call<SignedInBody>(action, "/api/auth/action", { jar, body: { mode: "verifyEmail", oobCode: oobCodeOf(lastMail(sendMail, "verifyEmail", email)!.data.actionUrl) } });
  expect(verified.status).toBe(200);
  return { jar, uid: verified.body.session.uid };
}

/** A jar carrying a session minted by the server for `uid` (after a claims change, which revokes the previous one). */
async function jarFor(uid: string): Promise<Jar> {
  const minted = await createSessionForUid(uid);
  const jar = new Jar();
  jar.cookies.set("__Host-session", minted.cookie);
  jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return jar;
}

function requestWith(jar: Jar): Request {
  return new Request(`${ORIGIN}/api/anything`, { method: "POST", headers: { host: "localhost:3000", origin: ORIGIN, cookie: jar.header() ?? "", "x-csrf-token": jar.get("__Host-csrf") ?? "" } });
}

beforeEach(() => resetRateLimiters());

describe("suspended account", () => {
  it("answers 403 account_suspended unless the route allows suspended members (messaging reads do, D9)", async () => {
    const { uid } = await verifiedAccount();
    await setClaims(uid, { role: "individual", st: "suspended" });
    const jar = await jarFor(uid);

    const who = await call<{ session: SignedInBody["session"] | null }>(me, "/api/auth/me", { jar });
    expect(who.body.session).toMatchObject({ uid, suspended: true });
    const refused = await call<ErrorBody>(profile, "/api/auth/profile", { jar, body: { displayName: "Still Me" } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("account_suspended");
    // Phase 5 (D2, D9): a suspended member still reads their conversations through the API, never writes.
    const conversations = await call<{ conversations: unknown[] }>(inbox, "/api/conversations", { jar });
    expect(conversations.status).toBe(200);
    expect(conversations.body.conversations).toEqual([]);
    expect((await call<{ total: number }>(unread, "/api/messages/unread", { jar })).status).toBe(200);
    const write = await call<ErrorBody>(startConversation, "/api/conversations", { jar, body: { listingId: "abcd2345", text: "Salam", turnstileToken: "t" } });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("account_suspended");

    await expect(requireUser(requestWith(jar), { mutation: true })).rejects.toMatchObject({ status: 403, code: "account_suspended" });
    const allowed = await requireUser(requestWith(jar), { mutation: true, allowSuspended: true });
    expect(allowed.user.uid).toBe(uid);
    expect(allowed.user.claims.st).toBe("suspended");
  });
});
