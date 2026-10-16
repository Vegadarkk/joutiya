import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI } from "@/config/ai";

// Exit criterion of phase 5 (DESIGN §5): when the Claude budget is exhausted (`claude.budget`
// degraded at 4 USD) or the API answers a spend-limit error, the agent switches to the free
// fallbacks, which never approve. All providers are mocked: no network call.

const store = new Map<string, string>();
const fakeValkey = {
  exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (args.includes("NX") && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }),
};
const degraded = new Set<string>();

vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => true, valkey: () => fakeValkey }));
vi.mock("@/lib/quota", () => ({
  consume: vi.fn(async () => ({ level: "ok" })),
  isDegraded: vi.fn(async (id: string) => degraded.has(id)),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

const { consume } = await import("@/lib/quota");
const { alert } = await import("@/lib/alert");
const { routeTask, guardFallback } = await import("@/lib/ai/router");
const { createAnthropicProvider } = await import("@/lib/ai/providers/anthropic");
const { createOpenAiModerationProvider } = await import("@/lib/ai/providers/openai-moderation");
const { createWorkersAiProvider } = await import("@/lib/ai/providers/workers-ai");
const { createRulesProvider } = await import("@/lib/ai/providers/rules");
const { SPEND_LIMIT_KEY, resetSpendLimitLatch } = await import("@/lib/ai/budget");
const { RetryableAiError } = await import("@/lib/ai/types");
type AiTaskInput = import("@/lib/ai/types").AiTaskInput;
type ClaudeClient = import("@/lib/ai/providers/anthropic").ClaudeClient;

const config = async () => DEFAULT_AI;

function listingInput(overrides: Partial<AiTaskInput> = {}): AiTaskInput {
  return {
    task: "listing_screen",
    target: { type: "listing", id: "abcdefgh" },
    text: "Titre : Vélo de route\nDescription : très bon état, contactez [téléphone].",
    images: [{ mediaType: "image/jpeg", data: "AAAA" }],
    facts: { kind: "listing", status: "pending_review", version: 3, flags: [], score: 10, hidden: false, openReports: 0, prohibitedHard: [] },
    inputHash: "h".repeat(64),
    ...overrides,
  };
}

function claudeMessage(parsed: unknown, stop: string = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    stop_reason: stop,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    parsed_output: stop === "end_turn" ? parsed : null,
  };
}

const approve = { action: "approve", policy: "none", severity: "none", confidence: 0.97, rationale: "Annonce conforme.", userMessage: "", templateId: "" };

function claudeClient(impl: () => Promise<unknown>) {
  const parse = vi.fn(impl);
  return { client: { messages: { parse } } as unknown as ClaudeClient, parse };
}

function openAi(scores: Record<string, number>) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ model: "omni-moderation-latest", results: [{ flagged: false, category_scores: scores }] }), { status: 200 }));
  return { provider: createOpenAiModerationProvider({ apiKey: "test-openai", fetch: fetch as unknown as typeof globalThis.fetch, config }), fetch };
}

function spendLimit400() {
  return Anthropic.APIError.generate(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC." } },
    undefined,
    new Headers(),
  );
}

function spendLimit429() {
  return Anthropic.APIError.generate(
    429,
    { type: "error", error: { type: "rate_limit_error", message: "Spend limit reached", details: { error_code: "enforced_spend_limit_reached" } } },
    undefined,
    new Headers(),
  );
}

beforeEach(() => {
  store.clear();
  degraded.clear();
  resetSpendLimitLatch();
  vi.mocked(consume).mockClear();
  vi.mocked(alert).mockClear();
});

describe("routeTask: Claude available", () => {
  it("answers with Claude and counts the cost into claude.budget", async () => {
    const { client, parse } = claudeClient(async () => claudeMessage(approve));
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client, config }), rules: createRulesProvider() });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.output).toMatchObject({ action: "approve", confidence: 0.97 });
    // 1000 x 0.10 + 100 x 0.50 + 2000 x 0.01 = 170 micro-USD.
    expect(result.costMicroUsd).toBe(170);
    expect(consume).toHaveBeenCalledWith("claude.budget", 170);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("sends the Haiku request shape: cached system prompt, thinking disabled, effort low, images first", async () => {
    const { client, parse } = claudeClient(async () => claudeMessage(approve));
    await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client, config }) });
    const params = parse.mock.calls[0]?.[0] as unknown as Record<string, unknown> & { system: { cache_control: unknown; text: string }[]; messages: { content: { type: string }[] }[]; output_config: { effort: string; format: { type: string; schema: unknown } } };
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(params.messages[0]?.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(params).not.toHaveProperty("temperature");
  });

  it("uses Sonnet at effort medium without a thinking parameter for appeals", async () => {
    const { client, parse } = claudeClient(async () => claudeMessage({ ...approve, action: "reject", confidence: 0.7 }));
    const result = await routeTask(
      { ...listingInput(), task: "appeal_review", target: { type: "decision", id: "d1" }, facts: { kind: "appeal", action: "remove", appealStatus: "open" } },
      { anthropic: createAnthropicProvider({ client, config }), rules: createRulesProvider() },
    );
    const params = parse.mock.calls[0]?.[0] as unknown as Record<string, unknown> & { output_config: { effort: string } };
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.output_config.effort).toBe("medium");
    expect(params).not.toHaveProperty("thinking");
    expect(result.output.action).toBe("reject");
  });

  it("clamps the model's numbers and texts after the parse", async () => {
    const { client } = claudeClient(async () => claudeMessage({ ...approve, confidence: 7, rationale: "x".repeat(5000), policy: "harassment" }));
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client, config }) });
    expect(result.output.confidence).toBe(1);
    expect(result.output.rationale.length).toBeLessThanOrEqual(1000);
    // harassment is not a listing reason.
    expect(result.output.policy).toBe("none");
  });
});

describe("routeTask: budget switch (exit criterion)", () => {
  it("skips Claude once claude.budget is degraded (4 USD) and never approves from the fallback", async () => {
    degraded.add("claude.budget");
    const { client, parse } = claudeClient(async () => claudeMessage(approve));
    const { provider: openai, fetch } = openAi({ sexual: 0.01, violence: 0.02 });
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client, config }), openai, rules: createRulesProvider() });
    expect(parse).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.provider).toBe("openai");
    expect(result.output.action).toBe("escalate");
    expect(result.costMicroUsd).toBe(0);
  });

  it("latches the switch on a 400 spend-limit error, alerts once and falls back", async () => {
    const { client, parse } = claudeClient(async () => {
      throw spendLimit400();
    });
    const { provider: openai } = openAi({ "sexual/minors": 0.0, illicit: 0.8 });
    const providers = { anthropic: createAnthropicProvider({ client, config }), openai, rules: createRulesProvider() };

    const first = await routeTask(listingInput(), providers);
    expect(first.provider).toBe("openai");
    expect(first.output).toMatchObject({ action: "hold", policy: "illegal_item", severity: "P1" });
    expect(first.error).toBe("anthropic: spend_limit");
    expect(store.has(SPEND_LIMIT_KEY)).toBe(true);
    expect(fakeValkey.set).toHaveBeenCalledWith(SPEND_LIMIT_KEY, expect.any(String), "PXAT", Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1), "NX");
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: "Claude : plafond de dépenses atteint" }));

    // Latched: the next task does not call Claude at all.
    const second = await routeTask(listingInput(), providers);
    expect(parse).toHaveBeenCalledOnce();
    expect(second.provider).toBe("openai");
    expect(second.error).toBeUndefined();
  });

  it("latches on a 429 enforced_spend_limit_reached and keeps the latch while Valkey is unreadable", async () => {
    const { client, parse } = claudeClient(async () => {
      throw spendLimit429();
    });
    const providers = { anthropic: createAnthropicProvider({ client, config }), rules: createRulesProvider() };
    const first = await routeTask(listingInput(), providers);
    expect(first.provider).toBe("rules");
    expect(first.output.action).toBe("escalate");
    store.clear();
    fakeValkey.exists.mockRejectedValueOnce(new Error("down"));
    await routeTask(listingInput(), providers);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("falls back from Claude to Workers AI when OpenAI is not configured", async () => {
    degraded.add("claude.budget");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { response: "unsafe\nS9", usage: { prompt_tokens: 500, completion_tokens: 5 } } }), { status: 200 }));
    const workers = createWorkersAiProvider({ token: "t", accountId: "acc", fetch: fetch as unknown as typeof globalThis.fetch, config });
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client: claudeClient(async () => claudeMessage(approve)).client, config }), openai: createOpenAiModerationProvider({ apiKey: "", config }), "workers-ai": workers, rules: createRulesProvider() });
    expect(result.provider).toBe("workers-ai");
    expect(result.output).toMatchObject({ action: "hold", policy: "illegal_item" });
    // ceil(500 x 0.044003 + 5 x 0.00273) = 23 neurons.
    expect(consume).toHaveBeenCalledWith("workersAi.neurons", 23);
  });

  it("ends on the rules provider for appeals when Claude is off", async () => {
    degraded.add("claude.budget");
    const { provider: openai, fetch } = openAi({});
    const result = await routeTask(
      { ...listingInput(), task: "appeal_review", target: { type: "decision", id: "d1" }, facts: { kind: "appeal", action: "remove", appealStatus: "open" } },
      { anthropic: createAnthropicProvider({ client: claudeClient(async () => claudeMessage(approve)).client, config }), openai, rules: createRulesProvider() },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: "rules", output: { action: "escalate", confidence: 0 } });
  });
});

describe("routeTask: failures", () => {
  it("throws a retryable error on a transient Claude failure, and falls back on the final attempt", async () => {
    const { client } = claudeClient(async () => {
      throw Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers());
    });
    const providers = { anthropic: createAnthropicProvider({ client, config }), rules: createRulesProvider() };
    await expect(routeTask(listingInput(), providers)).rejects.toBeInstanceOf(RetryableAiError);
    const final = await routeTask(listingInput(), providers, { final: true });
    expect(final).toMatchObject({ provider: "rules", error: "anthropic: retry_exhausted" });
    expect(store.has(SPEND_LIMIT_KEY)).toBe(false);
  });

  it("counts a refused answer's cost and falls back", async () => {
    const { client } = claudeClient(async () => claudeMessage(approve, "refusal"));
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client, config }), rules: createRulesProvider() });
    expect(result).toMatchObject({ provider: "rules", costMicroUsd: 170, error: "anthropic: refusal" });
    expect(consume).toHaveBeenCalledWith("claude.budget", 170);
  });

  it("alerts on an authentication error and falls back", async () => {
    const { client } = claudeClient(async () => {
      throw Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers());
    });
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client, config }), rules: createRulesProvider() });
    expect(result.provider).toBe("rules");
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2" }));
  });

  it("never lets a fallback approve or reject", () => {
    const output = { action: "approve" as const, policy: "none" as const, severity: "none" as const, confidence: 0.99, rationale: "ok" };
    expect(guardFallback("openai", output)).toMatchObject({ action: "escalate", confidence: 0 });
    expect(guardFallback("workers-ai", { ...output, action: "reject" })).toMatchObject({ action: "hold" });
    expect(guardFallback("anthropic", output)).toEqual(output);
  });

  it("guards a misbehaving fallback in the chain", async () => {
    degraded.add("claude.budget");
    const rogue = { id: "openai" as const, available: async () => true, run: async () => ({ output: { action: "approve" as const, policy: "none" as const, severity: "none" as const, confidence: 1, rationale: "ok" }, model: "x", costMicroUsd: 0 }) };
    const result = await routeTask(listingInput(), { anthropic: createAnthropicProvider({ client: claudeClient(async () => claudeMessage(approve)).client, config }), openai: rogue, rules: createRulesProvider() });
    expect(result.output.action).toBe("escalate");
  });
});
