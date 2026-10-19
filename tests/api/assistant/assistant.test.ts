import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Turnstile from "@/lib/security/turnstile";

// POST /api/assistant (design phase-5 D25, AF §6): the limits (20/hour and 50/day per device or
// account, 200/day per IP /64 then Turnstile), their closed policy, the degraded mode (help articles
// only), and nothing about the account in what Claude receives. Claude is a stub: no network.

const verify = vi.hoisted(() => vi.fn(async () => ({ ok: true, codes: [] as string[] })));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({ ...(await importOriginal<typeof Turnstile>()), verifyTurnstile: verify }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { POST } from "@/app/api/assistant/route";
import { RATE_LIMITS } from "@/config/rate-limits";
import { setAssistantClientForTests, type AssistantClient } from "@/lib/ai/assistant";
import type { AssistantResponse } from "@/lib/contracts/assistant";
import { resetServerEnv } from "@/lib/env";
import * as limiter from "@/lib/rate-limit/limiter";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { newDeviceCookie } from "@/lib/security/device";
import { Jar, ORIGIN, freshIp, type ErrorBody } from "../auth/helpers";
import { member } from "../listings/helpers";

type Body = AssistantResponse & ErrorBody;

function reply(parsed: unknown) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    parsed_output: parsed,
  };
}

const parse = vi.fn<(params: unknown) => Promise<unknown>>();

function visitor(): Jar {
  const jar = new Jar(freshIp());
  jar.cookies.set("__Host-did", newDeviceCookie().value);
  return jar;
}

const deviceKey = (jar: Jar) => `d:${(jar.get("__Host-did") ?? "").split(".")[0]}`;
const ipBucket = (jar: Jar) => requestIdentity(new Headers({ "x-forwarded-for": jar.ip })).ipBucket;

async function ask(body: Record<string, unknown>, jar: Jar, options: { origin?: string | null; csrf?: boolean } = {}): Promise<{ status: number; body: Body; response: Response }> {
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": jar.ip, "user-agent": "vitest", "content-type": "application/json" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.get("__Host-csrf");
  if (csrf && options.csrf !== false) headers.set("x-csrf-token", csrf);
  const response = await POST(new NextRequest(`${ORIGIN}/api/assistant`, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
  jar.absorb(response);
  return { status: response.status, body: (await response.json()) as Body, response };
}

async function spend(id: keyof typeof RATE_LIMITS, key: string): Promise<void> {
  await limiter.consumeLimit(id, key, RATE_LIMITS[id].points);
}

const question = { locale: "fr", question: "Le vendeur me demande un acompte par virement, que faire ?" };

beforeEach(() => {
  resetServerEnv();
  limiter.resetRateLimiters();
  verify.mockClear();
  parse.mockReset();
  parse.mockResolvedValue(reply({ answer: "Ne payez jamais avant d'avoir vu l'article.", articles: ["eviter-les-arnaques", "signaler-un-contenu"] }));
  setAssistantClientForTests({ messages: { parse } } as unknown as AssistantClient);
});
afterAll(() => setAssistantClientForTests(undefined));

describe("POST /api/assistant", () => {
  it("answers a visitor with Claude and the articles it used; sets the device cookie", async () => {
    const jar = new Jar(freshIp());
    const { status, body, response } = await ask(question, jar);
    expect(status).toBe(200);
    expect(body).toEqual({
      mode: "ai",
      answer: "Ne payez jamais avant d'avoir vu l'article.",
      articles: [
        { slug: "eviter-les-arnaques", title: "Éviter les arnaques", summary: expect.any(String) },
        { slug: "signaler-un-contenu", title: "Signaler un contenu", summary: expect.any(String) },
      ],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(jar.get("__Host-did")).toBeDefined();
    expect(parse).toHaveBeenCalledOnce();
  });

  it("sends nothing about the signed-in account to Claude", async () => {
    const someone = await member({ displayName: "Karima Benali" });
    const { status } = await ask({ ...question, history: [{ role: "user", text: "Bonjour" }, { role: "assistant", text: "Bonjour, que puis-je faire ?" }] }, someone.jar);
    expect(status).toBe(200);
    const sent = JSON.stringify(parse.mock.calls[0]?.[0]);
    expect(sent).not.toContain(someone.uid);
    expect(sent).not.toContain(someone.email);
    expect(sent).not.toContain("Karima");
    expect(sent).not.toContain("Benali");
    expect(sent).toContain("acompte par virement");
  });

  it("answers with help articles only when the AI is unavailable (no key, provider down)", async () => {
    setAssistantClientForTests(null);
    const none = await ask(question, visitor());
    expect(none.status).toBe(200);
    expect(none.body.mode).toBe("search");
    expect(none.body.articles[0]?.slug).toBe("eviter-les-arnaques");
    expect("answer" in none.body).toBe(false);

    setAssistantClientForTests({ messages: { parse } } as unknown as AssistantClient);
    parse.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: "reset" }));
    const down = await ask({ locale: "ar", question: "أريد الطعن في قرار حذف إعلاني" }, visitor());
    expect([down.status, down.body.mode]).toEqual([200, "search"]);
    expect(down.body.articles[0]).toMatchObject({ slug: "decisions-et-recours", title: "القرارات والطعون" });
  });

  it("limits each device to 20 questions an hour and 50 a day, before calling Claude", async () => {
    expect(RATE_LIMITS["assistant.device.hour"]).toMatchObject({ points: 20, policy: "closed" });
    expect(RATE_LIMITS["assistant.device.day"]).toMatchObject({ points: 50, policy: "closed" });
    const jar = visitor();
    await spend("assistant.device.hour", deviceKey(jar));
    const hour = await ask(question, jar);
    expect([hour.status, hour.body.error?.code]).toEqual([429, "rate_limited"]);
    expect(Number(hour.response.headers.get("retry-after"))).toBeGreaterThan(0);

    const other = visitor();
    await spend("assistant.device.day", deviceKey(other));
    expect((await ask(question, other)).status).toBe(429);
    expect(parse).not.toHaveBeenCalled();
  });

  it("counts a member per account, whatever the device", async () => {
    const someone = await member();
    await spend("assistant.device.day", `u:${someone.uid}`);
    someone.jar.cookies.set("__Host-did", newDeviceCookie().value);
    expect((await ask(question, someone.jar)).status).toBe(429);
  });

  it("asks for Turnstile past 200 questions a day from one IP, then lets the pass through", async () => {
    expect(RATE_LIMITS["assistant.ip"]).toMatchObject({ points: 200, policy: "closed" });
    const jar = visitor();
    await spend("assistant.ip", ipBucket(jar));
    const challenged = await ask(question, jar);
    expect([challenged.status, challenged.body.error?.code]).toEqual([403, "turnstile_required"]);
    expect(parse).not.toHaveBeenCalled();

    const solved = await ask({ ...question, turnstileToken: "solved" }, jar);
    expect(solved.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("solved", expect.objectContaining({ action: "assistant" }));
    expect(jar.get("__Host-tsv")).toBeDefined();
    verify.mockClear();
    expect((await ask(question, jar)).status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses with 503 when the limiter store is down (closed policy)", async () => {
    vi.mocked(limiter.enforceLimit).mockImplementationOnce(async (id) => limiter.assertLimit(id, { ok: false, reason: "unavailable" }));
    const down = await ask(question, visitor());
    expect([down.status, down.body.error?.code]).toEqual([503, "unavailable"]);

    vi.mocked(limiter.consumeLimit).mockImplementationOnce(async () => ({ ok: false, reason: "unavailable" }));
    const ipDown = await ask(question, visitor());
    expect([ipDown.status, ipDown.body.error?.code]).toEqual([503, "unavailable"]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin and an invalid body", async () => {
    expect((await ask(question, visitor(), { origin: "https://evil.example" })).body.error?.code).toBe("origin");
    expect((await ask({ ...question, question: "x".repeat(501) }, visitor())).status).toBe(400);
    expect((await ask({ ...question, locale: "en" }, visitor())).status).toBe(400);
    expect((await ask({ ...question, uid: "someone" }, visitor())).status).toBe(400);
    expect((await ask({ ...question, history: Array.from({ length: 7 }, () => ({ role: "user", text: "q" })) }, visitor())).status).toBe(400);
    expect(parse).not.toHaveBeenCalled();
  });
});
