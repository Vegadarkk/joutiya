import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { HELP_SLUGS, isHelpSlug, type HelpArticle, type HelpSlug } from "@/content/help";
import type { Locale } from "@/config/site";
import type { AssistantTurn } from "@/lib/contracts/assistant";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { z } from "@/lib/zod";
import { claudeBlocked, latchSpendLimit, recordClaudeCost } from "./budget";
import { aiConfig } from "./config";
import { maskPii } from "./mask";
import { assistantMessages, assistantPromptVersion, assistantSystemPrompt } from "./prompts/assistant";
import { classifyAnthropicError } from "./providers/anthropic";
import { ProviderError } from "./types";

// Assistant Joutiya (design phase-5 D25, AF §7 Z4): Claude Haiku 5.5 (`config/ai` models.assistant)
// answers from the locale's help corpus, the static system prompt cached one hour. Same SDK use as
// the moderation provider: `messages.parse` with a Zod output format, thinking disabled, effort
// low, no SDK retries. Each response's usage is priced into `claude.budget` (the monthly cap counts
// these calls); the budget switch, the spend-limit latch, a missing key, a provider error or an
// unusable answer all return "search": the route then shows help articles only. Nothing about the
// person reaches the model besides the masked text they typed.

const MAX_TOKENS = 700;
const TIMEOUT_MS = 20_000;
export const ANSWER_MAX = 1500;
export const CITED_MAX = 3;

/** The part of the SDK client the assistant uses (a stub in tests). */
export interface AssistantClient {
  messages: Pick<Anthropic["messages"], "parse">;
}

const outputSchema = z
  .object({
    answer: z.string().describe("The answer to the person, plain text, in the requested language"),
    articles: z.array(z.enum(HELP_SLUGS)).describe("Slugs of the help articles the answer relies on, most relevant first"),
  })
  .strict();
type ModelAnswer = z.infer<typeof outputSchema>;

export type SearchReason = "not_configured" | "budget" | "spend_limit" | "unavailable" | "unusable";
export type AssistantOutcome = { mode: "ai"; answer: string; cited: HelpSlug[] } | { mode: "search"; reason: SearchReason };

let override: { client: AssistantClient | null } | undefined;
let shared: AssistantClient | undefined;

/** Tests: a stub client, or null for "no API key"; undefined restores the real one. */
export function setAssistantClientForTests(client: AssistantClient | null | undefined): void {
  override = client === undefined ? undefined : { client };
}

function assistantClient(): AssistantClient | null {
  if (override) return override.client;
  const apiKey = serverEnv().ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  shared ??= new Anthropic({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
  return shared;
}

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

/** The answer bounded (length) and its citations limited to known, distinct slugs. */
export function clampAnswer(output: ModelAnswer): { answer: string; cited: HelpSlug[] } {
  const text = clean(output.answer);
  const answer = text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX - 1)}…` : text;
  const cited = [...new Set(output.articles.filter(isHelpSlug))].slice(0, CITED_MAX);
  return { answer, cited };
}

export interface AssistantInput {
  locale: Locale;
  question: string;
  history: readonly AssistantTurn[];
  /** The locale's corpus, placeholders filled (src/lib/help/search.ts loadHelpArticles). */
  articles: readonly HelpArticle[];
}

export async function askAssistant(input: AssistantInput): Promise<AssistantOutcome> {
  const client = assistantClient();
  if (!client) return { mode: "search", reason: "not_configured" };
  const blocked = await claudeBlocked();
  if (blocked) return { mode: "search", reason: blocked };

  const config = await aiConfig();
  const model = config.models.assistant;
  const system = assistantSystemPrompt(input.locale, input.articles);
  const messages = assistantMessages(
    maskPii(input.question),
    input.history.map((turn) => ({ role: turn.role, text: maskPii(turn.text) })),
  );
  const format = zodOutputFormat(outputSchema);
  // A refused or truncated answer does not match the schema: null instead of a throw, so the usage
  // of the billed call is still counted.
  const lenient = {
    ...format,
    parse: (content: string): ModelAnswer | null => {
      try {
        return format.parse(content);
      } catch {
        return null;
      }
    },
  };

  let response;
  try {
    response = await client.messages.parse({
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages,
      output_config: { effort: "low", format: lenient },
      ...(model.startsWith("claude-haiku-") ? { thinking: { type: "disabled" as const } } : {}),
    });
  } catch (error) {
    const classified = classifyAnthropicError(error);
    const spendLimit = classified instanceof ProviderError && classified.code === "spend_limit";
    if (spendLimit) await latchSpendLimit();
    logger.warn({ err: classified.message, prompt: assistantPromptVersion(system) }, "assistant: Claude unavailable, help search only");
    return { mode: "search", reason: spendLimit ? "spend_limit" : "unavailable" };
  }

  const costMicroUsd = await recordClaudeCost(config, model, response.usage);
  const parsed = response.stop_reason === "refusal" || response.stop_reason === "max_tokens" ? null : response.parsed_output;
  logger.info({ model, costMicroUsd, stop: response.stop_reason, prompt: assistantPromptVersion(system), cacheRead: response.usage.cache_read_input_tokens ?? 0 }, "assistant answer");
  if (!parsed) return { mode: "search", reason: "unusable" };
  const { answer, cited } = clampAnswer(parsed);
  if (!answer) return { mode: "search", reason: "unusable" };
  return { mode: "ai", answer, cited };
}
